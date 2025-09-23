const { subscribe, setToken, send, hasSubscriptions, createVirtualSocket, deleteVirtualSocket, unsubscribe, copySubscriptions } = require('warpsocket');

// Most E2E tests run with threads: 0 so this runs on the main thread.
function handleOpen() {
  return true;
}

function handleTextMessage(data, socketId, currentToken) {
  const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  switch (msg.type) {
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
      const unsubResult = require('warpsocket').unsubscribe(msg.socketId || socketId, msg.channel);
      // unsubResult is now an array of newly unsubscribed socket IDs
      const wasRemoved = unsubResult.includes(msg.socketId || socketId);
      send(socketId, JSON.stringify({ type: 'unsubscribed', channel: msg.channel, wasRemoved: wasRemoved }));
      break;
    case 'copySubs':
      const copyResult = require('warpsocket').copySubscriptions(msg.fromChannel, msg.toChannel);
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
    case 'auth':
      setToken(socketId, typeof msg.token === 'string' ? msg.token : JSON.stringify(msg.token));
      send(socketId, JSON.stringify({ type: 'authenticated' }));
      break;
    case 'echoToken':
      send(socketId, JSON.stringify({ type: 'token', token: currentToken ? Buffer.from(currentToken).toString('utf8') : null }));
      break;
    case 'getSocketId':
      send(socketId, JSON.stringify({ type: 'socketId', socketId: socketId }));
      break;
    case 'createVirtualSocket':
      const virtualSocketId = createVirtualSocket(msg.targetSocketId || socketId, msg.userData);
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
    case 'whoami':
      if (!globalThis.__workerId) {
        globalThis.__workerId = Math.random().toString(36).slice(2, 8);
      }
      // small jitter to avoid synchronized responses
      const jitter = Math.floor(Math.random() * 5);
      setTimeout(() => {
        send(socketId, JSON.stringify({ type: 'whoami', pid: process.pid, wid: globalThis.__workerId }));
      }, jitter);
      break;
  }
}

module.exports = { handleOpen, handleTextMessage };
