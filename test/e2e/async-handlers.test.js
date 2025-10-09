const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnCustomServer, createWebSocket, onceMessageOfType, onceMessage } = require('../helpers/testUtils');

test('async handlers properly await Promise resolution', async () => {
  const url = await spawnCustomServer({
    workerPath: path.join(__dirname, '..', 'fixtures', 'test-worker-async.js')
  });

  const ws = await createWebSocket(url);

  // Send async echo message
  ws.send(JSON.stringify({
    type: 'asyncEcho',
    data: 'hello async',
    delay: 50
  }));

  // Should receive response after Promise resolves
  const response = await onceMessageOfType(ws, 'asyncEchoResponse', 2000);
  assert.strictEqual(response.original, 'hello async');
  assert.strictEqual(response.delay, 50);

  ws.close();
});

test('sequential execution of async handlers', async () => {
  const url = await spawnCustomServer({
    workerPath: path.join(__dirname, '..', 'fixtures', 'test-worker-async.js')
  });

  const ws = await createWebSocket(url);

  // Send multiple sequential messages with different delays
  ws.send(JSON.stringify({ type: 'sequentialTest', sequence: 1, delay: 50 }));
  ws.send(JSON.stringify({ type: 'sequentialTest', sequence: 2, delay: 25 }));
  ws.send(JSON.stringify({ type: 'sequentialTest', sequence: 3, delay: 0 }));

  // Should receive responses in order (sequential execution)
  const response1 = await onceMessageOfType(ws, 'sequentialResponse', 2000);
  const response2 = await onceMessageOfType(ws, 'sequentialResponse', 2000);
  const response3 = await onceMessageOfType(ws, 'sequentialResponse', 2000);

  assert.strictEqual(response1.sequence, 1);
  assert.strictEqual(response2.sequence, 2);
  assert.strictEqual(response3.sequence, 3);

  // Verify timestamps show sequential processing (each response after the previous one)
  assert.ok(response1.timestamp <= response2.timestamp);
  assert.ok(response2.timestamp <= response3.timestamp);

  ws.close();
});

test('async timeout', async () => {
  const url = await spawnCustomServer({
    workerPath: path.join(__dirname, '..', 'fixtures', 'test-worker-async.js')
  });

  const ws = await createWebSocket(url);

  // Send multiple sequential messages with different delays
  ws.send(JSON.stringify({ type: 'sequentialTest', sequence: 1, delay: 6000 }));

  // Should receive responses in order (sequential execution)
  try {
    const msg = await onceMessage(ws, 8000);
    assert.fail('Expected timeout error, but received message: ' + JSON.stringify(msg));
  } catch(err) {
    assert.match(err.message, /Internal server error/);
  }

  ws.close();
});

test('async handler rejection closes connection', async () => {
  const url = await spawnCustomServer({
    workerPath: path.join(__dirname, '..', 'fixtures', 'test-worker-async.js')
  });

  const ws = await createWebSocket(url);

  // Send message that causes Promise rejection
  ws.send(JSON.stringify({
    type: 'asyncReject',
    delay: 20
  }));

  // Connection should be closed due to rejection
  await new Promise((resolve) => {
    ws.on('close', () => resolve());
    // Timeout after 1 second if not closed
    setTimeout(() => resolve(), 1000);
  });

  // WebSocket should be closed
  assert.strictEqual(ws.readyState, ws.CLOSED);

  ws.close();
});

test('sync handlers still work alongside async handlers', async () => {
  const url = await spawnCustomServer({
    workerPath: path.join(__dirname, '..', 'fixtures', 'test-worker-async.js')
  });

  const ws = await createWebSocket(url);

  // Send sync message
  ws.send(JSON.stringify({
    type: 'syncEcho',
    data: 'hello sync'
  }));

  // Should receive immediate response
  const response = await onceMessageOfType(ws, 'syncEchoResponse', 100);
  assert.strictEqual(response.original, 'hello sync');

  ws.close();
});

test('mixed sync and async handlers maintain order', async () => {
  const url = await spawnCustomServer({
    workerPath: path.join(__dirname, '..', 'fixtures', 'test-worker-async.js')
  });

  const ws = await createWebSocket(url);

  // Send mixed sync and async messages
  ws.send(JSON.stringify({ type: 'syncEcho', data: 'sync1' }));
  ws.send(JSON.stringify({ type: 'asyncEcho', data: 'async1', delay: 30 }));
  ws.send(JSON.stringify({ type: 'syncEcho', data: 'sync2' }));

  // Should receive in order: sync1, async1, sync2
  const response1 = await onceMessageOfType(ws, 'syncEchoResponse', 200);
  const response2 = await onceMessageOfType(ws, 'asyncEchoResponse', 2000);
  const response3 = await onceMessageOfType(ws, 'syncEchoResponse', 200);

  assert.strictEqual(response1.original, 'sync1');
  assert.strictEqual(response2.original, 'async1');
  assert.strictEqual(response3.original, 'sync2');

  ws.close();
});