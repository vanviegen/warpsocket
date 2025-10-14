const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createWebSocket, spawnCustomServer, onceMessageOfType } = require('../helpers/testUtils.js');

// Test handleStart functionality with workerArg
test('handleStart is called with workerArg when provided', async () => {
  const testArg = { config: 'test-config', value: 42 };
  const url = await spawnCustomServer({ 
    threads: 2,
    workerPath: path.resolve('test/fixtures/test-worker.js'),
    workerArg: testArg
  });

  const ws = await createWebSocket(url);
  
  // Request the startup arg from the worker
  ws.send(JSON.stringify({ type: 'getStartupArg' }));
  const response = await onceMessageOfType(ws, 'startupArg');
  
  assert.deepStrictEqual(response.arg, testArg, 'Worker should receive the correct workerArg');
  
  ws.close();
});

test('handleStart is called with undefined when workerArg not provided', async () => {
  const url = await spawnCustomServer({ 
    threads: 1,
    workerPath: path.resolve('test/fixtures/test-worker.js')
    // No workerArg provided
  });

  const ws = await createWebSocket(url);
  
  // Request the startup arg from the worker
  ws.send(JSON.stringify({ type: 'getStartupArg' }));
  const response = await onceMessageOfType(ws, 'startupArg');
  
  assert.strictEqual(response.arg, undefined, 'Worker should receive undefined when no workerArg provided');
  
  ws.close();
});

test('all workers receive the same workerArg', async () => {
  const testArg = { sharedConfig: 'all-workers' };
  const url = await spawnCustomServer({ 
    threads: 3,
    workerPath: path.resolve('test/fixtures/test-worker.js'),
    workerArg: testArg
  });

  const clients = await Promise.all(Array.from({ length: 6 }, () => createWebSocket(url)));

  // Ask each client which worker is handling it and what startup arg it received
  clients.forEach((ws) => ws.send(JSON.stringify({ type: 'whoami' })));
  const infos = await Promise.all(clients.map((ws) => onceMessageOfType(ws, 'whoami')));

  // Verify we have multiple workers and all received the same arg
  const unique = new Set(infos.map((i) => `${i.pid}:${i.wid}`));
  assert.ok(unique.size >= 2, `Expected at least 2 distinct workers, got ${unique.size}`);
  
  // All workers should have received the same startupArg
  infos.forEach((info, index) => {
    assert.deepStrictEqual(info.startupArg, testArg, `Worker ${index} should have received the correct startupArg`);
  });

  clients.forEach(ws => ws.close());
});

test('handleStart works with minimum threads=1', async () => {
  const testArg = { singleWorker: true, value: 123 };
  const url = await spawnCustomServer({ 
    threads: 1, // Minimum number of threads
    workerPath: path.resolve('test/fixtures/test-worker.js'),
    workerArg: testArg
  });

  const ws = await createWebSocket(url);
  
  // Request the startup arg from the worker
  ws.send(JSON.stringify({ type: 'getStartupArg' }));
  const response = await onceMessageOfType(ws, 'startupArg');
  
  assert.deepStrictEqual(response.arg, testArg, 'Single worker should receive the correct workerArg');
  
  ws.close();
});

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
  await Promise.all(clients.map((ws) => onceMessageOfType(ws, 'published', 5000)));

  // Cause errors on two workers
  clients[0].send(JSON.stringify({ type: 'error' }));
  clients[1].send(JSON.stringify({ type: 'error' }));

  // Publish a message from the third client
  clients[2].send(JSON.stringify({ type: 'pub', channel: 'room', data: 'hello' }));
  // Check if remaining clients received the message (clients 2-7, since 0 and 1 are disconnected)
  await Promise.all(clients.slice(2).map((ws) => onceMessageOfType(ws, 'published', 5000)));
});

