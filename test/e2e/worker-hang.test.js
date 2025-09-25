const test = require('node:test');
const assert = require('node:assert');
const { createWebSocket, spawnCustomServer, onceMessageOfType } = require('../helpers/testUtils.js');

test('worker hang detection and cleanup', async () => {
  // Start server with 2 workers 
  const url = await spawnCustomServer({ threads: 2 });

  // Create 4 clients with delays to ensure round-robin distribution
  const clients = [];
  for (let i = 0; i < 4; i++) {
    clients.push(await createWebSocket(url));
    // Small delay between connections to ensure round-robin
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  // Get worker info for each client
  clients.forEach((ws) => ws.send(JSON.stringify({ type: 'whoami' })));
  const infos = await Promise.all(clients.map((ws) => onceMessageOfType(ws, 'whoami')));

  // Group clients by worker
  const workerGroups = {};
  infos.forEach((info, index) => {
    const workerId = `${info.pid}:${info.wid}`;
    if (!workerGroups[workerId]) {
      workerGroups[workerId] = [];
    }
    workerGroups[workerId].push({ client: clients[index], info });
  });

  const workerIds = Object.keys(workerGroups);
  assert.ok(workerIds.length >= 2, `Expected at least 2 workers, got ${workerIds.length}`);
  
  // Subscribe all clients to the same channel
  clients.forEach((ws) => ws.send(JSON.stringify({ type: 'sub', channel: 'room' })));
  await Promise.all(clients.map((ws) => onceMessageOfType(ws, 'subscribed')));

  // Test broadcast works initially
  clients[0].send(JSON.stringify({ type: 'pub', channel: 'room', data: 'initial test' }));
  await Promise.all(clients.map((ws) => onceMessageOfType(ws, 'published')));

  // Pick the first worker to hang
  const [hangWorkerId] = workerIds;
  const hangWorkerClients = workerGroups[hangWorkerId];
  const otherWorkerClients = workerIds.slice(1).flatMap(id => workerGroups[id]);

  // Set up disconnect listeners for hung worker clients
  const disconnectPromises = hangWorkerClients.map(({ client }, index) => 
    new Promise((resolve) => {
      client.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'pong') {
          assert.fail(`Client ${index} received pong from hung worker (unexpected!)`);
        }
      });
      
      client.once('close', (code, reason) => {
        resolve({ code, reason });
      });
    })
  );

  // Hang one worker
  hangWorkerClients[0].client.send(JSON.stringify({ type: 'hang' }));

  // Wait for the worker to be detected as hanging and terminated (3 second timeout + margin)
  
  // Periodically send messages to trigger dead worker detection
  const messageInterval = setInterval(() => {
    hangWorkerClients.forEach(({ client }, index) => {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify({ type: 'ping' }));
      }
    });
  }, 500);

  const disconnectResults = await Promise.all(disconnectPromises);
  clearInterval(messageInterval);

  // Verify disconnect reasons (should be error codes due to worker termination)
  disconnectResults.forEach(({ code }) => {
    assert.ok(code === 1006 || code === 1011, `Expected error close code, got ${code}`);
  });

  // Test that other workers are still functional
  if (otherWorkerClients.length > 0) {
    // Wait a bit for cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const testClient = otherWorkerClients[0].client;
    testClient.send(JSON.stringify({ type: 'pub', channel: 'room', data: 'after hang test' }));
    
    // Only expect responses from non-hung worker clients that are still connected
    const stillConnectedClients = otherWorkerClients.filter(({ client }) => 
      client.readyState === client.OPEN
    );
    
    if (stillConnectedClients.length > 0) {
      await Promise.all(stillConnectedClients.map(({ client }) => 
        onceMessageOfType(client, 'published')
      ));
    } else {
      assert.fail('No other workers had connected clients');
    }
  }

  // Clean up
  clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) {
      ws.close();
    }
  });
});
