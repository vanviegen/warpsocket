const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { spawnServer } = require('../helpers/spawnServer.js');

const open = (ws) => new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
const onceMessageOfType = (ws, type, timeout=2000) => new Promise((resolve, reject) => {
  const onMsg = (m) => {
    const obj = JSON.parse(m.toString());
    if (!type || obj.type === type) {
      ws.off('message', onMsg);
      resolve(obj);
    }
  };
  ws.on('message', onMsg);
  if (timeout != null) setTimeout(reject, timeout);
});

// Open several connections concurrently to improve distribution across workers
// and assert that at least two distinct worker IDs respond.
test('responses come from different workers when threads>1', async () => {
  const srv = await spawnServer({ threads: 4 });

  const clients = Array.from({ length: 8 }, () => new WebSocket(srv.url));
  try {
    await Promise.all(clients.map(open));

    // Ask each client which worker is handling it
    clients.forEach((ws) => ws.send(JSON.stringify({ type: 'whoami' })));
    const infos = await Promise.all(clients.map((ws) => onceMessageOfType(ws, 'whoami')));

    const unique = new Set(infos.map((i) => `${i.pid}:${i.wid}`));
    assert.ok(unique.size >= 2, `Expected at least 2 distinct workers, got ${unique.size}`);

    // Subscribe all clients to the same channel
    clients.forEach((ws) => ws.send(JSON.stringify({ type: 'sub', channel: 'room' })));
    await Promise.all(clients.map((ws) => onceMessageOfType(ws, 'subscribed')));
    
    // Publish a message from the first client
    clients[0].send(JSON.stringify({ type: 'pub', channel: 'room', data: 'hello' }));

    // Check if all clients received the message
    await Promise.all(clients.map((ws) => onceMessageOfType(ws, 'published')));

  } finally {
    clients.forEach((ws) => {
      try { ws.close(); } catch {}
    });
    srv.kill();
  }
});
