const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { spawnServer } = require('../helpers/spawnServer.js');

const open = (ws) => new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
const onceMessage = (ws) => new Promise((r) => ws.once('message', (m) => r(m.toString())));

test('broadcast to channel reaches subscribers (threads:0)', async () => {
  const srv = await spawnServer();

  const a = new WebSocket(srv.url);
  const b = new WebSocket(srv.url);
  await Promise.all([open(a), open(b)]);

  a.send(JSON.stringify({ type: 'sub', channel: 'room' }));
  b.send(JSON.stringify({ type: 'sub', channel: 'room' }));
  await Promise.all([onceMessage(a), onceMessage(b)]); // subscribed acks

  const received = onceMessage(b);
  a.send(JSON.stringify({ type: 'pub', channel: 'room', data: 'hello' }));

  const msg = await received;
  const parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'published');
  assert.equal(parsed.data, 'hello');

  a.close(); b.close(); srv.kill();
});
