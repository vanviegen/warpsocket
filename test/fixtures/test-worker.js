const { subscribe, setToken, send, hasSubscriptions, createVirtualSocket, deleteVirtualSocket } = require('warpsocket');

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
      subscribe(msg.socketId || socketId, msg.channel);
      send(socketId, JSON.stringify({ type: 'subscribed', channel: msg.channel }));
      break;
    case 'pub':
      const data = msg.binary ? Buffer.from(msg.data) : JSON.stringify({ type: 'published', channel: msg.channel, data: msg.data });
      send(msg.channel, data);
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
