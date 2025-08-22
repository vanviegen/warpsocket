const { subscribe, sendToChannel, setToken, send } = require('warpws');

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
      subscribe(socketId, msg.channel);
      send(socketId, JSON.stringify({ type: 'subscribed', channel: msg.channel }));
      break;
    case 'pub':
      sendToChannel(msg.channel, JSON.stringify({ type: 'published', channel: msg.channel, data: msg.data }));
      break;
    case 'auth':
      setToken(socketId, typeof msg.token === 'string' ? msg.token : JSON.stringify(msg.token));
      send(socketId, JSON.stringify({ type: 'authenticated' }));
      break;
    case 'echoToken':
      send(socketId, JSON.stringify({ type: 'token', token: currentToken ? Buffer.from(currentToken).toString('utf8') : null }));
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
