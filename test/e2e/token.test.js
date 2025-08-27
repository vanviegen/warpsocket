const test = require('node:test');
const assert = require('node:assert');
const { createWebSocket, onceMessage } = require('../helpers/testUtils.js');

test('token is stored and echoed back', async () => {
  const ws = await createWebSocket();

  ws.send(JSON.stringify({ type: 'auth', token: 'abc123' }));
  await onceMessage(ws); // authenticated ack

  ws.send(JSON.stringify({ type: 'echoToken' }));
  const reply = JSON.parse(await onceMessage(ws));

  assert.equal(reply.type, 'token');
  assert.equal(reply.token, 'abc123');
});
