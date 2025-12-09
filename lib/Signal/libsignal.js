"use strict";

var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2){
    if(k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if(!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)){
        desc = { enumerable: true, get: function(){ return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : function(o, m, k, k2){ if(k2 === undefined) k2 = k; o[k2] = m[k]; });

var __setModuleDefault = (this && this.__setModuleDefault) || function(o, v){
    o["default"] = v;
};

var __importStar = (this && this.__importStar) || function(mod){
    if(mod && mod.__esModule) return mod;
    var result = {};
    for(var k in mod) if(k !== "default" && Object.prototype.hasOwnProperty.call(mod, k))
        __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};

Object.defineProperty(exports, "__esModule", { value: true });
exports.makeLibSignalRepository = makeLibSignalRepository;

const libsignal = __importStar(require("libsignal"));
const Utils_1 = require("../Utils");
const WABinary_1 = require("../WABinary");
const sender_key_name_1 = require("./Group/sender-key-name");
const sender_key_record_1 = require("./Group/sender-key-record");
const Group_1 = require("./Group");

function makeLibSignalRepository(auth) {
    const storage = signalStorage(auth);

    return {
        async decryptGroupMessage({ group, authorJid, msg }) {
            const senderName = jidToSignalSenderKeyName(group, authorJid);
            const cipher = new Group_1.GroupCipher(storage, senderName);
            try {
                return await cipher.decrypt(msg);
            } catch {
                return null;
            }
        },

        async processSenderKeyDistributionMessage({ item, authorJid }) {
            if (!item.groupId) throw new Error('Group ID required');
            const senderName = jidToSignalSenderKeyName(item.groupId, authorJid);
            const builder = new Group_1.GroupSessionBuilder(storage);
            const senderMsg = new Group_1.SenderKeyDistributionMessage(
                null, null, null, null, item.axolotlSenderKeyDistributionMessage
            );
            const { [senderName.toString()]: key } = await auth.keys.get('sender-key', [senderName.toString()]);
            if (!key) await storage.storeSenderKey(senderName, new sender_key_record_1.SenderKeyRecord());
            await builder.process(senderName, senderMsg);
        },

        async decryptMessage({ jid, type, ciphertext }) {
            const addr = jidToSignalProtocolAddress(jid);
            const session = new libsignal.SessionCipher(storage, addr);
            try {
                if (type === 'pkmsg') return await session.decryptPreKeyWhisperMessage(ciphertext);
                if (type === 'msg') return await session.decryptWhisperMessage(ciphertext);
                throw new Error(`Unknown type: ${type}`);
            } catch {
                return null;
            }
        },

        async encryptMessage({ jid, data }) {
            const addr = jidToSignalProtocolAddress(jid);
            const cipher = new libsignal.SessionCipher(storage, addr);
            const { type: sigType, body } = await cipher.encrypt(data);
            return { type: sigType === 3 ? 'pkmsg' : 'msg', ciphertext: Buffer.from(body, 'binary') };
        },

        async encryptGroupMessage({ group, meId, data }) {
            const senderName = jidToSignalSenderKeyName(group, meId);
            const builder = new Group_1.GroupSessionBuilder(storage);
            const { [senderName.toString()]: senderKey } = await auth.keys.get('sender-key', [senderName.toString()]);
            if (!senderKey) await storage.storeSenderKey(senderName, new sender_key_record_1.SenderKeyRecord());
            const skDistMsg = await builder.create(senderName);
            const session = new Group_1.GroupCipher(storage, senderName);
            const ciphertext = await session.encrypt(data);
            return {
                ciphertext,
                senderKeyDistributionMessage: skDistMsg.serialize()
            };
        },

        async injectE2ESession({ jid, session }) {
            const cipher = new libsignal.SessionBuilder(storage, jidToSignalProtocolAddress(jid));
            await cipher.initOutgoing(session);
        },

        jidToSignalProtocolAddress(jid) {
            return jidToSignalProtocolAddress(jid).toString();
        }
    };
}

const jidToSignalProtocolAddress = (jid) => {
    const { user, device } = (0, WABinary_1.jidDecode)(jid);
    return new libsignal.ProtocolAddress(user, device || 0);
};

const jidToSignalSenderKeyName = (group, user) => {
    return new sender_key_name_1.SenderKeyName(group, jidToSignalProtocolAddress(user));
};

function signalStorage({ creds, keys }) {
    return {
        loadSession: async (id) => {
            const { [id]: sess } = await keys.get('session', [id]);
            return sess ? libsignal.SessionRecord.deserialize(sess) : new libsignal.SessionRecord();
        },

        storeSession: async (id, session) => {
            await keys.set({ session: { [id]: session.serialize() } });
        },

        isTrustedIdentity: () => true,

        loadPreKey: async (id) => {
            const { [id.toString()]: key } = await keys.get('pre-key', [id.toString()]);
            if (key) return { privKey: Buffer.from(key.private), pubKey: Buffer.from(key.public) };
        },

        removePreKey: (id) => keys.set({ 'pre-key': { [id]: null } }),

        loadSignedPreKey: () => {
            const k = creds.signedPreKey;
            return { privKey: Buffer.from(k.keyPair.private), pubKey: Buffer.from(k.keyPair.public) };
        },

        loadSenderKey: async (senderName) => {
            const { [senderName.toString()]: key } = await keys.get('sender-key', [senderName.toString()]);
            return key ? sender_key_record_1.SenderKeyRecord.deserialize(key) : new sender_key_record_1.SenderKeyRecord();
        },

        storeSenderKey: async (senderName, key) => {
            const serialized = JSON.stringify(key.serialize());
            await keys.set({ 'sender-key': { [senderName.toString()]: Buffer.from(serialized, 'utf-8') } });
        },

        getOurRegistrationId: () => creds.registrationId,

        getOurIdentity: () => {
            const k = creds.signedIdentityKey;
            return { privKey: Buffer.from(k.private), pubKey: (0, Utils_1.generateSignalPubKey)(k.public) };
        }
    };
}