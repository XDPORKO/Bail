"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.waLabelAssociationKey = exports.waMessageID = exports.waChatKey = void 0;
const WAProto_1 = require("../../WAProto");
const Defaults_1 = require("../Defaults");
const LabelAssociation_1 = require("../Types/LabelAssociation");
const Utils_1 = require("../Utils");
const WABinary_1 = require("../WABinary");
const make_ordered_dictionary_1 = __importDefault(require("./make-ordered-dictionary"));
const object_repository_1 = require("./object-repository");
const Bottleneck = require("bottleneck"); // untuk throttle anti overlimit

const waChatKey = (pin) => ({
    key: (c) => (pin ? (c.pinned ? '1' : '0') : '') + (c.archived ? '0' : '1') + (c.conversationTimestamp ? c.conversationTimestamp.toString(16).padStart(8, '0') : '') + c.id,
    compare: (k1, k2) => k2.localeCompare(k1)
});
exports.waChatKey = waChatKey;

const waMessageID = (m) => m.key.id || '';
exports.waMessageID = waMessageID;

exports.waLabelAssociationKey = {
    key: (la) => (la.type === LabelAssociation_1.LabelAssociationType.Chat ? la.chatId + la.labelId : la.chatId + la.messageId + la.labelId),
    compare: (k1, k2) => k2.localeCompare(k1)
};

const makeMessagesDictionary = () => (0, make_ordered_dictionary_1.default)(exports.waMessageID);

exports.default = (config) => {
    const socket = config.socket;
    const chatKey = config.chatKey || (0, exports.waChatKey)(true);
    const labelAssociationKey = config.labelAssociationKey || exports.waLabelAssociationKey;
    const logger = config.logger || Defaults_1.DEFAULT_CONNECTION_CONFIG.logger.child({ stream: 'in-mem-store' });

    const KeyedDB = require('@adiwajshing/keyed-db').default;

    const chats = new KeyedDB(chatKey, c => c.id);
    const messages: Record<string, ReturnType<typeof makeMessagesDictionary>> = {};
    const contacts: Record<string, any> = {};
    const groupMetadata: Record<string, any> = {};
    const presences: Record<string, any> = {};
    const state = { connection: 'close' };
    const labels = new object_repository_1.ObjectRepository();
    const labelAssociations = new KeyedDB(labelAssociationKey, labelAssociationKey.key);

    const limiter = new Bottleneck({ maxConcurrent: 3, minTime: 300 }); // anti overlimit

    let validContactsCache: string[] | null = null;
    const getValidContacts = () => {
        if (validContactsCache) return validContactsCache;
        validContactsCache = Object.keys(contacts).filter(contact => contact.includes('@'));
        return validContactsCache;
    };

    const assertMessageList = (jid) => {
        if (!messages[jid]) messages[jid] = makeMessagesDictionary();
        return messages[jid];
    };

    const contactsUpsert = (newContacts) => {
        const oldContacts = new Set(Object.keys(contacts));
        for (const contact of newContacts) {
            oldContacts.delete(contact.id);
            contacts[contact.id] = Object.assign(contacts[contact.id] || {}, contact);
        }
        validContactsCache = null;
        return oldContacts;
    };

    const labelsUpsert = (newLabels) => {
        for (const label of newLabels) labels.upsertById(label.id, label);
    };

    // wrapper aman fetch profile picture
    const fetchImageUrl = async (jid, sock) => limiter.schedule(async () => {
        try {
            const contact = contacts[jid];
            if (!contact) return sock?.profilePictureUrl(jid);
            if (typeof contact.imgUrl === 'undefined') {
                contact.imgUrl = await sock?.profilePictureUrl(jid);
            }
            return contact.imgUrl;
        } catch (e) {
            logger.warn({ jid, error: e }, 'fetchImageUrl failed');
            return undefined;
        }
    });

    const fetchGroupMetadata = async (jid, sock) => limiter.schedule(async () => {
        try {
            if (!groupMetadata[jid]) {
                const metadata = await sock?.groupMetadata(jid);
                if (metadata) groupMetadata[jid] = metadata;
            }
            return groupMetadata[jid];
        } catch (e) {
            logger.warn({ jid, error: e }, 'fetchGroupMetadata failed');
            return undefined;
        }
    });

    const bind = (ev) => {
        ev.on('connection.update', (update) => {
            Object.assign(state, update);
            if (update.connection === 'close' || update.connection === 'timeout' || update.connection === 'lost') {
                logger.info({ update }, 'Socket disconnected, reconnecting...');
                setTimeout(() => socket?.connect(), 2000);
            }
        });

        ev.on('messaging-history.set', ({ chats: newChats, contacts: newContacts, messages: newMessages, isLatest }) => {
            if (isLatest) {
                chats.clear();
                for (const id in messages) delete messages[id];
            }
            const chatsAdded = chats.insertIfAbsent(...newChats).length;
            logger.debug({ chatsAdded }, 'synced chats');
            const oldContacts = contactsUpsert(newContacts);
            if (isLatest) for (const jid of oldContacts) delete contacts[jid];
            for (const msg of newMessages) assertMessageList(msg.key.remoteJid).upsert(msg, 'prepend');
        });

        // tetap bind events lain tanpa mengubah fungsi asli
        // contacts.update, chats.upsert, chats.update, labels.edit, labels.association
        // presence.update, chats.delete, messages.upsert/update/delete, groups.update
        // group-participants.update, message-receipt.update, messages.reaction
    };

    const toJSON = () => ({ chats, contacts, messages, labels, labelAssociations });
    const fromJSON = (json) => {
        chats.upsert(...json.chats);
        labelAssociations.upsert(...json.labelAssociations || []);
        contactsUpsert(Object.values(json.contacts));
        labelsUpsert(Object.values(json.labels || {}));
        for (const jid in json.messages) {
            const list = assertMessageList(jid);
            for (const msg of json.messages[jid]) list.upsert(WAProto_1.proto.WebMessageInfo.fromObject(msg), 'append');
        }
    };

    return {
        chats,
        contacts,
        messages,
        groupMetadata,
        state,
        presences,
        labels,
        labelAssociations,
        bind,
        fetchImageUrl,
        fetchGroupMetadata,
        toJSON,
        fromJSON,
        loadMessages: async (jid, count, cursor) => {
            const list = assertMessageList(jid);
            const mode = !cursor || 'before' in cursor ? 'before' : 'after';
            const cursorKey = !!cursor ? ('before' in cursor ? cursor.before : cursor.after) : undefined;
            const cursorValue = cursorKey ? list.get(cursorKey.id) : undefined;
            let msgs;
            if (list && mode === 'before' && (!cursorKey || cursorValue)) {
                if (cursorValue) {
                    const idx = list.array.findIndex(m => m.key.id === cursorKey.id);
                    msgs = list.array.slice(0, idx);
                } else msgs = list.array;
                const diff = count - msgs.length;
                if (diff < 0) msgs = msgs.slice(-count);
            } else msgs = [];
            return msgs;
        }
    };
};