const {
    subscribe,
    send,
    hasSubscriptions,
    createVirtualSocket,
    deleteVirtualSocket,
    unsubscribe,
    copySubscriptions,
    getKey,
    setKey,
    setKeyIf
} = require('warpsocket');

// Store the workerArg passed to handleStart for testing
let startupArg = null;

function handleStart(workerArg) {
    startupArg = workerArg;
}

function handleOpen() {
    return true;
}

function handleTextMessage(data, socketId) {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    switch (msg.type) {
        case 'asyncEcho':
            // Return a Promise that resolves after a delay
            return new Promise((resolve) => {
                setTimeout(() => {
                    send(socketId, JSON.stringify({
                        type: 'asyncEchoResponse',
                        original: msg.data,
                        delay: msg.delay || 10
                    }));
                    resolve();
                }, msg.delay || 10);
            });

        case 'asyncReject':
            // Return a Promise that rejects
            return new Promise((resolve, reject) => {
                setTimeout(() => {
                    reject(new Error('Intentional async rejection'));
                }, msg.delay || 10);
            });

        case 'sequentialTest':
            // Return a Promise that includes sequence info
            return new Promise((resolve) => {
                setTimeout(() => {
                    send(socketId, JSON.stringify({
                        type: 'sequentialResponse',
                        sequence: msg.sequence,
                        timestamp: Date.now()
                    }));
                    resolve();
                }, msg.delay || 5);
            });

        case 'syncEcho':
            // Synchronous response for comparison
            send(socketId, JSON.stringify({
                type: 'syncEchoResponse',
                original: msg.data
            }));
            break;

        case 'getStartupArg':
            send(socketId, JSON.stringify({ type: 'startupArg', arg: startupArg }));
            break;

        case 'whoami':
            if (!globalThis.__workerId) {
                globalThis.__workerId = Math.random().toString(36).slice(2, 8);
            }
            send(socketId, JSON.stringify({
                type: 'whoami',
                pid: process.pid,
                wid: globalThis.__workerId,
                startupArg: startupArg
            }));
            break;
    }
}

module.exports = { handleStart, handleOpen, handleTextMessage };