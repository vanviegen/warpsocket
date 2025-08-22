const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { spawnServer } = require('../helpers/spawnServer.js');

const open = (ws) => new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
const onceMessage = (ws) => new Promise((r) => ws.once('message', (m) => r(m.toString())));

test('token is stored and echoed back', async () => {
  const srv = await spawnServer();

  const ws = new WebSocket(srv.url);
  await open(ws);

  ws.send(JSON.stringify({ type: 'auth', token: 'abc123' }));
  await onceMessage(ws); // authenticated ack

  ws.send(JSON.stringify({ type: 'echoToken' }));
  const reply = JSON.parse(await onceMessage(ws));

  assert.equal(reply.type, 'token');
  assert.equal(reply.token, 'abc123');

  ws.close(); srv.kill();
});
