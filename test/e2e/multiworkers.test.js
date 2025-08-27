const test = require('node:test');
const assert = require('node:assert');
const { createWebSocket, spawnCustomServer, onceMessageOfType } = require('../helpers/testUtils.js');

// Open several connections concurrently to improve distribution across workers
// and assert that at least two distinct worker IDs respond.
test('responses come from different workers when threads>1', async () => {
  const url = await spawnCustomServer({ threads: 4 });

  const clients = await Promise.all(Array.from({ length: 8 }, () => createWebSocket(url)));

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
});
