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
        case 'getStartupArg':
            send(socketId, JSON.stringify({ type: 'startupArg', arg: startupArg }));
            break;
        case 'sub':
            const subResult = subscribe(msg.socketId || socketId, msg.channel);
            // subResult is now an array of newly subscribed socket IDs
            const isNew = subResult.includes(msg.socketId || socketId);
            send(socketId, JSON.stringify({ type: 'subscribed', channel: msg.channel, isNew: isNew }));
            break;
        case 'subArray':
            const subArrayResult = subscribe(msg.socketIds, msg.channel);
            // subArrayResult is now an array of newly subscribed socket IDs
            // Convert to array of booleans indicating if each socket was newly subscribed
            const results = msg.socketIds.map(socketId => subArrayResult.includes(socketId));
            send(socketId, JSON.stringify({ type: 'subscribedArray', channel: msg.channel, results: results }));
            break;
        case 'unsub':
            const unsubResult = unsubscribe(msg.socketId || socketId, msg.channel);
            // unsubResult is now an array of newly unsubscribed socket IDs
            const wasRemoved = unsubResult.includes(msg.socketId || socketId);
            send(socketId, JSON.stringify({ type: 'unsubscribed', channel: msg.channel, wasRemoved: wasRemoved }));
            break;
        case 'copySubs':
            const copyResult = copySubscriptions(msg.fromChannel, msg.toChannel);
            send(socketId, JSON.stringify({ type: 'subsCopied', fromChannel: msg.fromChannel, toChannel: msg.toChannel, newSocketIds: copyResult }));
            break;
        case 'unsubFromChannel':
            // Unsubscribe all subscribers of fromChannel from toChannel using negative delta
            const unsubFromChannelResult = subscribe(msg.fromChannel, msg.toChannel, -(msg.delta || 1));
            send(socketId, JSON.stringify({ type: 'unsubscribedFromChannel', fromChannel: msg.fromChannel, toChannel: msg.toChannel, removedSocketIds: unsubFromChannelResult }));
            break;
        case 'pub':
            const data = msg.binary ? Buffer.from(msg.data) : JSON.stringify({ type: 'published', channel: msg.channel, data: msg.data });
            const pubSendCount = send(msg.channel, data);
            if (msg.returnCount) {
                send(socketId, JSON.stringify({ type: 'publishResult', count: pubSendCount }));
            }
            break;
        case 'hasSubscriptions':
            const hasSubs = hasSubscriptions(msg.channel);
            send(socketId, JSON.stringify({ type: 'hasSubscriptions', channel: msg.channel, result: hasSubs }));
            break;
        case 'getSocketId':
            send(socketId, JSON.stringify({ type: 'socketId', socketId: socketId }));
            break;
        case 'createVirtualSocket':
            let userPrefix = msg.userPrefix;
            // Convert array to Buffer if needed
            if (Array.isArray(userPrefix)) {
                userPrefix = Buffer.from(userPrefix);
            }
            const virtualSocketId = createVirtualSocket(msg.targetSocketId || socketId, userPrefix);
            send(socketId, JSON.stringify({ type: 'virtualSocketCreated', virtualSocketId: virtualSocketId }));
            break;
        case 'deleteVirtualSocket':
            const success = deleteVirtualSocket(msg.virtualSocketId, msg.expectedTargetSocketId);
            send(socketId, JSON.stringify({ type: 'virtualSocketDeleted', success: success }));
            break;
        case 'sendToSockets':
            const socketIds = msg.socketIds;
            const messageData = msg.binary ? Buffer.from(msg.data) : JSON.stringify({ type: 'directMessage', data: msg.data });
            const sendCount = send(socketIds, messageData);
            send(socketId, JSON.stringify({ type: 'sendResult', count: sendCount }));
            break;
        case 'kvSet':
            {
                const oldRaw = setKey(msg.key, msg.value);
                const oldValue = oldRaw ? Buffer.from(oldRaw).toString('utf8') : null;
                send(socketId, JSON.stringify({ type: 'kvSetAck', key: msg.key, oldValue }));
            }
            break;
        case 'kvGet':
            {
                const rawValue = getKey(msg.key);
                const exists = !!rawValue;
                const value = rawValue ? Buffer.from(rawValue).toString('utf8') : null;
                send(socketId, JSON.stringify({ type: 'kvGetResult', key: msg.key, exists, value }));
            }
            break;
        case 'kvSetIf':
            {
                const success = setKeyIf(msg.key, msg.newValue, msg.checkValue);
                const currentRaw = getKey(msg.key);
                const currentValue = currentRaw ? Buffer.from(currentRaw).toString('utf8') : null;
                send(socketId, JSON.stringify({
                    type: 'kvSetIfResult',
                    key: msg.key,
                    success,
                    attemptValue: msg.newValue ?? null,
                    currentValue
                }));
            }
            break;
        case 'whoami':
            if (!globalThis.__workerId) {
                globalThis.__workerId = Math.random().toString(36).slice(2, 8);
            }
            // small jitter to avoid synchronized responses
            const jitter = Math.floor(Math.random() * 5);
            setTimeout(() => {
                send(socketId, JSON.stringify({ 
                    type: 'whoami', 
                    pid: process.pid, 
                    wid: globalThis.__workerId,
                    startupArg: startupArg 
                }));
            }, jitter);
            break;
        case 'error':
            ({}).noSuchMethod();
            break;
        case 'hang':
            while(true){}
            break;
        case 'ping':
            // Respond to ping messages - this will trigger dead worker detection when worker is dead
            send(socketId, JSON.stringify({ type: 'pong' }));
            break;
    }
}

module.exports = { handleStart, handleOpen, handleTextMessage };
