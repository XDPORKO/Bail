"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useMultiFileAuthState = void 0;
const { Mutex } = require("async-mutex");
const { writeFile, readFile, unlink, stat, mkdir, copyFile } = require("fs/promises");
const { join } = require("path");
const { proto: WAProto } = require("../../WAProto");
const { initAuthCreds } = require("./auth-utils");
const { BufferJSON } = require("./generics");

const fileLocks = new Map();
const getFileLock = (path) => {
    if (!fileLocks.has(path)) fileLocks.set(path, new Mutex());
    return fileLocks.get(path);
};
const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-');

const useMultiFileAuthState = async (folder) => {

    const writeData = async (data, file) => {
        const filePath = join(folder, fixFileName(file));
        const mutex = getFileLock(filePath);
        const release = await mutex.acquire();
        try {
            // backup dulu sebelum overwrite
            await copyFile(filePath, filePath + '.bak').catch(() => { });
            await writeFile(filePath, JSON.stringify(data, BufferJSON.replacer));
        } finally {
            release();
        }
    };

    const readData = async (file) => {
        try {
            const filePath = join(folder, fixFileName(file));
            const mutex = getFileLock(filePath);
            const release = await mutex.acquire();
            try {
                const data = await readFile(filePath, { encoding: 'utf-8' });
                return JSON.parse(data, BufferJSON.reviver);
            } finally {
                release();
            }
        } catch {
            return null;
        }
    };

    const removeData = async (file) => {
        try {
            const filePath = join(folder, fixFileName(file));
            const mutex = getFileLock(filePath);
            const release = await mutex.acquire();
            try {
                await unlink(filePath);
            } catch { }
            finally {
                release();
            }
        } catch { }
    };

    const folderInfo = await stat(folder).catch(() => null);
    if (folderInfo && !folderInfo.isDirectory()) {
        throw new Error(`Found a file at ${folder}, delete it or use another folder`);
    }
    if (!folderInfo) await mkdir(folder, { recursive: true });

    let creds = await readData('creds.json') || initAuthCreds();

    // fungsi auto-reconnect / restore creds jika corrupt
    const restoreCreds = async () => {
        const backup = await readData('creds.json.bak');
        if (backup) {
            creds = backup;
            await writeData(creds, 'creds.json');
        }
    };

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}.json`);
                        if (type === 'app-state-sync-key' && value) {
                            value = WAProto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const file = `${category}-${id}.json`;
                            tasks.push(value ? writeData(value, file) : removeData(file));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            try {
                await writeData(creds, 'creds.json');
            } catch {
                // jika gagal, restore dari backup
                await restoreCreds();
            }
        },
        restoreCreds
    };
};

exports.useMultiFileAuthState = useMultiFileAuthState;