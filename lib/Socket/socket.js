"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.makeSocket = void 0;

const { Boom } = require("@hapi/boom");
const { randomBytes } = require("crypto");
const { URL } = require("url");
const { promisify } = require("util");
const WAProto = require("../../WAProto");
const Defaults = require("../Defaults");
const Types = require("../Types");
const Utils = require("../Utils");
const WABinary = require("../WABinary");
const Client = require("./Client");

const makeSocket = (config) => {
    const {
        waWebSocketUrl,
        connectTimeoutMs,
        logger,
        keepAliveIntervalMs,
        browser,
        auth: authState,
        printQRInTerminal,
        defaultQueryTimeoutMs,
        transactionOpts,
        qrTimeout,
        makeSignalRepository,
    } = config;

    const url = typeof waWebSocketUrl === 'string' ? new URL(waWebSocketUrl) : waWebSocketUrl;

    if (config.mobile || url.protocol === 'tcp:') {
        throw new Boom('Mobile API not supported', { statusCode: Types.DisconnectReason.loggedOut });
    }

    if (url.protocol === 'wss' && authState?.creds?.routingInfo) {
        url.searchParams.append('ED', authState.creds.routingInfo.toString('base64url'));
    }

    const ws = new Client.WebSocketClient(url, config);
    ws.connect();

    const ev = Utils.makeEventBuffer(logger);
    const ephemeralKeyPair = Utils.Curve.generateKeyPair();
    const noise = Utils.makeNoiseHandler({
        keyPair: ephemeralKeyPair,
        NOISE_HEADER: Defaults.NOISE_WA_HEADER,
        logger,
        routingInfo: authState?.creds?.routingInfo
    });

    const { creds } = authState;
    const keys = Utils.addTransactionCapability(authState.keys, logger, transactionOpts);
    const signalRepository = makeSignalRepository({ creds, keys });

    let lastDateRecv;
    let epoch = 1;
    let keepAliveReq;
    let qrTimer;
    let closed = false;
    const uqTagId = Utils.generateMdTagPrefix();

    const generateMessageTag = () => `${uqTagId}${epoch++}`;
    const sendPromise = promisify(ws.send);

    const sendRawMessage = async (data) => {
        if (!ws.isOpen) throw new Boom('Connection Closed', { statusCode: Types.DisconnectReason.connectionClosed });
        const bytes = noise.encodeFrame(data);
        await Utils.promiseTimeout(connectTimeoutMs, async (resolve, reject) => {
            try {
                await sendPromise.call(ws, bytes);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    };

    const sendNode = (frame) => {
        if (logger.level === 'trace') {
            logger.trace({ xml: WABinary.binaryNodeToString(frame), msg: 'xml send' });
        }
        return sendRawMessage(WABinary.encodeBinaryNode(frame));
    };

    const onUnexpectedError = (err, msg) => {
        logger.error({ err }, `unexpected error in '${msg}'`);
        const message = (err?.stack || err?.message || String(err)).toLowerCase();

        if (message.includes('bad mac') || (message.includes('mac') && message.includes('invalid'))) {
            uploadPreKeysToServerIfRequired(true).catch(e => logger.warn({ e }, 'failed to re-upload prekeys'));
        }

        if (message.includes('429') || message.includes('rate limit')) {
            const wait = Math.min(30000, config.backoffDelayMs || 5000);
            logger.info({ wait }, 'backing off due to rate limit');
            setTimeout(() => {}, wait);
        }
    };

    const awaitNextMessage = async (sendMsg) => {
        if (!ws.isOpen) throw new Boom('Connection Closed', { statusCode: Types.DisconnectReason.connectionClosed });
        let onOpen, onClose;
        const result = Utils.promiseTimeout(connectTimeoutMs, (resolve, reject) => {
            onOpen = resolve;
            onClose = mapWebSocketError(reject);
            ws.on('frame', onOpen);
            ws.on('close', onClose);
            ws.on('error', onClose);
        }).finally(() => {
            ws.off('frame', onOpen);
            ws.off('close', onClose);
            ws.off('error', onClose);
        });

        if (sendMsg) sendRawMessage(sendMsg).catch(onClose);
        return result;
    };

    const waitForMessage = async (msgId, timeoutMs = defaultQueryTimeoutMs) => {
        let onRecv, onErr;
        try {
            return await Utils.promiseTimeout(timeoutMs, (resolve, reject) => {
                onRecv = resolve;
                onErr = err => reject(err || new Boom('Connection Closed', { statusCode: Types.DisconnectReason.connectionClosed }));
                ws.on(`TAG:${msgId}`, onRecv);
                ws.on('close', onErr);
                ws.off('error', onErr);
            });
        } finally {
            ws.off(`TAG:${msgId}`, onRecv);
            ws.off('close', onErr);
            ws.off('error', onErr);
        }
    };

    const query = async (node, timeoutMs) => {
        if (!node.attrs.id) node.attrs.id = generateMessageTag();
        const msgId = node.attrs.id;
        const [result] = await Promise.all([waitForMessage(msgId, timeoutMs), sendNode(node)]);
        if ('tag' in result) WABinary.assertNodeErrorFree(result);
        return result;
    };

    const end = (error) => {
        if (closed) return;
        closed = true;
        clearInterval(keepAliveReq);
        clearTimeout(qrTimer);
        ws.removeAllListeners();
        if (!ws.isClosed && !ws.isClosing) ws.close();
        ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } });
        ev.removeAllListeners('connection.update');
    };

    const waitForSocketOpen = async () => {
        if (ws.isOpen) return;
        if (ws.isClosed || ws.isClosing) throw new Boom('Connection Closed', { statusCode: Types.DisconnectReason.connectionClosed });
        let onOpen, onClose;
        await new Promise((resolve, reject) => {
            onOpen = () => resolve(undefined);
            onClose = mapWebSocketError(reject);
            ws.on('open', onOpen);
            ws.on('close', onClose);
            ws.on('error', onClose);
        }).finally(() => {
            ws.off('open', onOpen);
            ws.off('close', onClose);
            ws.off('error', onClose);
        });
    };

    const startKeepAliveRequest = () => {
        keepAliveReq = setInterval(() => {
            if (!lastDateRecv) lastDateRecv = new Date();
            const diff = Date.now() - lastDateRecv.getTime();

            if (diff > keepAliveIntervalMs + 5000) {
                end(new Boom('Connection was lost', { statusCode: Types.DisconnectReason.connectionLost }));
            } else if (ws.isOpen) {
                query({ tag: 'iq', attrs: { id: generateMessageTag(), to: WABinary.S_WHATSAPP_NET, type: 'get', xmlns: 'w:p' }, content: [{ tag: 'ping', attrs: {} }] })
                    .catch(err => logger.error({ trace: err.stack }, 'error in keep alive'));
            } else {
                logger.warn('keep alive called when WS not open');
            }
        }, keepAliveIntervalMs);
    };

    // Event listeners
    ws.on('message', (data) => {
        lastDateRecv = new Date();
        noise.decodeFrame(data, frame => ws.emit('frame', frame));
    });

    ws.on('open', async () => {
        try { await validateConnection(); } 
        catch (err) { logger.error({ err }, 'error in validating connection'); end(err); }
    });

    ws.on('error', mapWebSocketError(end));
    ws.on('close', () => end(new Boom('Connection Terminated', { statusCode: Types.DisconnectReason.connectionClosed })));

    if (printQRInTerminal) Utils.printQRIfNecessaryListener(ev, logger);

    return {
        type: 'md',
        ws,
        ev,
        authState: { creds, keys },
        signalRepository,
        user: authState.creds.me,
        generateMessageTag,
        query,
        waitForMessage,
        waitForSocketOpen,
        sendRawMessage,
        sendNode,
        logout: async (msg) => { end(new Boom(msg || 'Intentional Logout', { statusCode: Types.DisconnectReason.loggedOut })); },
        end,
        onUnexpectedError,
        uploadPreKeys,
        uploadPreKeysToServerIfRequired,
        requestPairingCode,
        waitForConnectionUpdate: Utils.bindWaitForConnectionUpdate(ev),
        sendWAMBuffer,
    };
};

exports.makeSocket = makeSocket;

function mapWebSocketError(handler) {
    return (error) => {
        handler(new Boom(`WebSocket Error (${error?.message})`, { statusCode: Utils.getCodeFromWSError(error), data: error }));
    };
}