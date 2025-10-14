const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createWebSocket, spawnCustomServer, onceMessageOfType, onceMessage } = require('../helpers/testUtils.js');

test('getDebugState with kv mode', async () => {
  const addon = require('warpsocket/addon-loader');

  addon.setKey('testkey', 'testvalue');

  const kv = addon.getDebugState('kv');

  assert.deepStrictEqual(kv, [{key: Buffer.from('testkey'), value: Buffer.from('testvalue')}]);
});

test('getDebugState with workers mode - with active server', async () => {
  const url = await spawnCustomServer({
    threads: 2,
    workerPath: path.resolve('test/fixtures/test-worker.js')
  });

  const ws = await createWebSocket(url);

  // Request debug state from the server
  ws.send(JSON.stringify({ type: 'getDebugState', mode: 'workers' }));
  const response = await onceMessageOfType(ws, 'debugState');

  const workers = response.state;

  // Should have 2 workers
  assert.strictEqual(workers.length, 2);
  workers.forEach(worker => {
    assert.strictEqual(typeof worker.workerId, 'number');
    assert.strictEqual(typeof worker.hasTextHandler, 'boolean');
    assert.strictEqual(typeof worker.hasBinaryHandler, 'boolean');
    assert.strictEqual(typeof worker.hasCloseHandler, 'boolean');
    assert.strictEqual(typeof worker.hasOpenHandler, 'boolean');
  });

  // Test getting a specific worker using a separate WebSocket
  const ws2 = await createWebSocket(url);
  ws2.send(JSON.stringify({ type: 'getDebugState', mode: 'workers', key: workers[0].workerId }));
  const specificResponse = await onceMessageOfType(ws2, 'debugState');
  assert.deepStrictEqual(specificResponse.state, workers[0]);
  ws2.close();

  // Test getting a non-existent worker using a separate WebSocket
  const ws3 = await createWebSocket(url);
  ws3.send(JSON.stringify({ type: 'getDebugState', mode: 'workers', key: 99999 }));
  const nonexistentResponse = await onceMessageOfType(ws3, 'debugState');
  assert.strictEqual(nonexistentResponse.state, undefined);
  ws3.close();

  ws.close();
});

test('getDebugState with sockets mode - with active connections', async () => {
  const url = await spawnCustomServer({
    threads: 1,
    workerPath: path.resolve('test/fixtures/test-worker.js')
  });

  const ws1 = await createWebSocket(url);
  const ws2 = await createWebSocket(url);

  // Wait a bit for connections to establish
  await new Promise(resolve => setTimeout(resolve, 100));

  // Request debug state from the server
  ws1.send(JSON.stringify({ type: 'getDebugState', mode: 'sockets' }));
  const response = await onceMessageOfType(ws1, 'debugState');

  const sockets = response.state;

  // Should have 2 sockets
  assert.strictEqual(sockets.length, 2);
  sockets.forEach(socket => {
    assert.strictEqual(typeof socket.socketId, 'number');
    assert.strictEqual(typeof socket.ip, 'string');
    assert.strictEqual(typeof socket.workerId, 'number');
  });

  // Test getting a specific socket using a separate WebSocket
  const ws3 = await createWebSocket(url);
  ws3.send(JSON.stringify({ type: 'getDebugState', mode: 'sockets', key: sockets[0].socketId }));
  const specificResponse = await onceMessageOfType(ws3, 'debugState');
  assert.deepStrictEqual(specificResponse.state, sockets[0]);
  ws3.close();

  // Test getting a non-existent socket using a separate WebSocket
  const ws4 = await createWebSocket(url);
  ws4.send(JSON.stringify({ type: 'getDebugState', mode: 'sockets', key: 99999 }));
  const nonexistentResponse = await onceMessageOfType(ws4, 'debugState');
  assert.strictEqual(nonexistentResponse.state, undefined);
  ws4.close();

  ws1.close();
  ws2.close();
});

test('getDebugState with channels mode - with active subscriptions', async () => {
  const url = await spawnCustomServer({
    threads: 1,
    workerPath: path.resolve('test/fixtures/test-worker.js')
  });

  // Connect two clients
  const ws1 = await createWebSocket(url);
  const ws2 = await createWebSocket(url);

  // Subscribe to channels
  ws1.send(JSON.stringify({ type: 'sub', channel: 'room1' }));
  ws1.send(JSON.stringify({ type: 'sub', channel: 'room2' }));
  ws2.send(JSON.stringify({ type: 'sub', channel: 'room1' }));

  // Wait for subscriptions
  await onceMessageOfType(ws1, 'subscribed');
  await onceMessageOfType(ws1, 'subscribed');
  await onceMessageOfType(ws2, 'subscribed');

  // Request debug state from the server
  ws1.send(JSON.stringify({ type: 'getDebugState', mode: 'channels' }));
  const response = await onceMessageOfType(ws1, 'debugState');

  const channels = response.state;

  // Should have 2 channels: 'room1' and 'room2'
  assert.strictEqual(channels.length, 2);
  
  channels.forEach(channel => {
    // Channel name is a Buffer, which gets serialized as {type: 'Buffer', data: [...]}
    assert.ok(channel.channel);
    assert.ok(channel.channel.type === 'Buffer' || Buffer.isBuffer(channel.channel));
    assert.ok(typeof channel.subscribers === 'object');
    // Verify subscribers are present
    const subscriberIds = Object.keys(channel.subscribers);
    assert.ok(subscriberIds.length > 0);
  });

  ws1.close();
  ws2.close();
});