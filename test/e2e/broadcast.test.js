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

test('hasSubscriptions returns correct status', async () => {
  const srv = await spawnServer();

  const a = new WebSocket(srv.url);
  const b = new WebSocket(srv.url);
  await Promise.all([open(a), open(b)]);

  // Check channel has no subscriptions initially
  a.send(JSON.stringify({ type: 'hasSubscriptions', channel: 'test-room' }));
  let msg = await onceMessage(a);
  let parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'hasSubscriptions');
  assert.equal(parsed.channel, 'test-room');
  assert.equal(parsed.result, false);

  // Subscribe one client
  a.send(JSON.stringify({ type: 'sub', channel: 'test-room' }));
  await onceMessage(a); // subscribed ack

  // Check channel now has subscriptions
  a.send(JSON.stringify({ type: 'hasSubscriptions', channel: 'test-room' }));
  msg = await onceMessage(a);
  parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'hasSubscriptions');
  assert.equal(parsed.channel, 'test-room');
  assert.equal(parsed.result, true);

  // Subscribe second client
  b.send(JSON.stringify({ type: 'sub', channel: 'test-room' }));
  await onceMessage(b); // subscribed ack

  // Check channel still has subscriptions
  a.send(JSON.stringify({ type: 'hasSubscriptions', channel: 'test-room' }));
  msg = await onceMessage(a);
  parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'hasSubscriptions');
  assert.equal(parsed.channel, 'test-room');
  assert.equal(parsed.result, true);

  // Close one client
  b.close();
  
  // Give some time for cleanup
  await new Promise(resolve => setTimeout(resolve, 100));

  // Check channel still has subscriptions (client a is still connected)
  a.send(JSON.stringify({ type: 'hasSubscriptions', channel: 'test-room' }));
  msg = await onceMessage(a);
  parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'hasSubscriptions');
  assert.equal(parsed.channel, 'test-room');
  assert.equal(parsed.result, true);

  // Close remaining client
  a.close();
  srv.kill();
});
