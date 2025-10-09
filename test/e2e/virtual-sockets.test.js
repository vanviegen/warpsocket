const test = require('node:test');
const assert = require('node:assert');
const { createWebSocket, onceMessageRaw, onceMessageOfType } = require('../helpers/testUtils.js');

test('createVirtualSocket returns a new socket ID', async () => {
    const ws = await createWebSocket();
    
    // Create a virtual socket (defaults to current socket as target)
    ws.send(JSON.stringify({ type: 'createVirtualSocket' }));
    const virtualSocketResponse = await onceMessageOfType(ws, 'virtualSocketCreated');
    
    assert.ok(typeof virtualSocketResponse.virtualSocketId === 'number');
});

test('virtual socket can subscribe to channels and receive messages', async () => {
    const ws1 = await createWebSocket();
    const ws2 = await createWebSocket();
    
    // Create virtual socket (defaults to ws1 as target)
    ws1.send(JSON.stringify({ type: 'createVirtualSocket' }));
    const virtualSocketResponse = await onceMessageOfType(ws1, 'virtualSocketCreated');
    const virtualSocketId = virtualSocketResponse.virtualSocketId;
    
    // Subscribe the virtual socket to a channel
    ws1.send(JSON.stringify({ type: 'sub', socketId: virtualSocketId, channel: 'test-room' }));
    await onceMessageOfType(ws1, 'subscribed');
    
    // Send a message to the channel from ws2
    ws2.send(JSON.stringify({ type: 'pub', channel: 'test-room', data: 'hello virtual' }));
    
    // ws1 should receive the message since the virtual socket subscribed
    const publishedMessage = await onceMessageOfType(ws1, 'published');
    assert.equal(publishedMessage.data, 'hello virtual');
    assert.equal(publishedMessage.channel, 'test-room');
});

test('deleteVirtualSocket removes the virtual socket', async () => {
    const ws = await createWebSocket();
    
    // Create virtual socket (defaults to current socket as target)
    ws.send(JSON.stringify({ type: 'createVirtualSocket' }));
    const virtualSocketResponse = await onceMessageOfType(ws, 'virtualSocketCreated');
    const virtualSocketId = virtualSocketResponse.virtualSocketId;
    
    // Delete the virtual socket
    ws.send(JSON.stringify({ type: 'deleteVirtualSocket', virtualSocketId: virtualSocketId }));
    const deleteResponse = await onceMessageOfType(ws, 'virtualSocketDeleted');
    assert.equal(deleteResponse.success, true);
    
    // Try to delete the same virtual socket again (should return false)
    ws.send(JSON.stringify({ type: 'deleteVirtualSocket', virtualSocketId: virtualSocketId }));
    const deleteResponse2 = await onceMessageOfType(ws, 'virtualSocketDeleted');
    assert.equal(deleteResponse2.success, false);
});

test('virtual socket with user prefix prefixes text messages', async () => {
    const ws1 = await createWebSocket();
    const ws2 = await createWebSocket();
    
    // Create virtual socket with user prefix
    const userPrefix = 'PREFIX:';
    ws1.send(JSON.stringify({ type: 'createVirtualSocket', userPrefix: userPrefix }));
    const {virtualSocketId} = await onceMessageOfType(ws1, 'virtualSocketCreated');
    
    ws1.send(JSON.stringify({ type: 'sub', socketId: virtualSocketId, channel: 'test-prefix' }));
    await onceMessageOfType(ws1, 'subscribed');
    
    // Send message to channel - user prefix should be automatically prepended
    ws2.send(JSON.stringify({ type: 'pub', channel: 'test-prefix', data: 'hello' }));
    
    // The message should come back as binary with prefix prepended (because prefixing makes it binary)
    const rawMessage = await onceMessageRaw(ws1);
    // Check if it's a Buffer or ArrayBuffer
    assert.ok(rawMessage instanceof ArrayBuffer || Buffer.isBuffer(rawMessage));
    
    // Convert binary to text and check the prefix
    const textMessage = new TextDecoder().decode(rawMessage);
    assert.ok(textMessage.startsWith(userPrefix));
    
    // Parse the JSON part (after the prefix)
    const jsonPart = textMessage.slice(userPrefix.length);
    const message = JSON.parse(jsonPart);
    assert.equal(message.type, 'published');
    assert.equal(message.data, 'hello');
    assert.equal(message.channel, 'test-prefix');
});

test('virtual socket with user prefix prefixes binary messages', async () => {
    const ws1 = await createWebSocket();
    const ws2 = await createWebSocket();
    
    // Create virtual socket with user prefix (binary data)
    const userPrefix = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    ws1.send(JSON.stringify({ type: 'createVirtualSocket', userPrefix: Array.from(userPrefix) }));
    const virtualResponse = await onceMessageOfType(ws1, 'virtualSocketCreated');
    const virtualSocketId = virtualResponse.virtualSocketId;
    
    ws1.send(JSON.stringify({ type: 'sub', socketId: virtualSocketId, channel: 'test-binary-prefix' }));
    await onceMessageOfType(ws1, 'subscribed');
    
    // Send binary message to channel
    ws2.send(JSON.stringify({ type: 'pub', channel: 'test-binary-prefix', data: 'binary-test', binary: true }));
    
    // The message should come as binary with the user prefix prepended
    const binaryMessage = await onceMessageRaw(ws1);
    assert.ok(binaryMessage instanceof ArrayBuffer);
    
    const receivedBytes = new Uint8Array(binaryMessage);
    
    // Check that the first 4 bytes match our prefix
    for (let i = 0; i < userPrefix.length; i++) {
        assert.equal(receivedBytes[i], userPrefix[i]);
    }
    
    // The rest should be the original data
    const originalData = new TextDecoder().decode(binaryMessage.slice(userPrefix.length));
    assert.equal(originalData, 'binary-test');
});

test('virtual socket without user prefix receives messages normally', async () => {
    const ws1 = await createWebSocket();
    const ws2 = await createWebSocket();
    
    // Create virtual socket without user prefix
    ws1.send(JSON.stringify({ type: 'createVirtualSocket' }));
    const {virtualSocketId} = await onceMessageOfType(ws1, 'virtualSocketCreated');
    
    ws1.send(JSON.stringify({ type: 'sub', socketId: virtualSocketId, channel: 'test-no-prefix' }));
    await onceMessageOfType(ws1, 'subscribed');
    
    // Send message to channel
    ws2.send(JSON.stringify({ type: 'pub', channel: 'test-no-prefix', data: 'hello normal' }));
    
    // Message should be received without modification
    const message = await onceMessageOfType(ws1, 'published');
    assert.equal(message.data, 'hello normal');
});

test('deleteVirtualSocket with expectedTargetSocketId works correctly', async () => {
    const ws = await createWebSocket();
    
    // Create virtual socket (defaults to current socket as target)
    ws.send(JSON.stringify({ type: 'createVirtualSocket' }));
    const virtualSocketResponse = await onceMessageOfType(ws, 'virtualSocketCreated');
    const virtualSocketId = virtualSocketResponse.virtualSocketId;
    
    // Get the actual socket ID
    ws.send(JSON.stringify({ type: 'getSocketId' }));
    const socketIdResponse = await onceMessageOfType(ws, 'socketId');
    const actualSocketId = socketIdResponse.socketId;
    
    // Try to delete with wrong expected target (should fail)
    ws.send(JSON.stringify({ 
        type: 'deleteVirtualSocket', 
        virtualSocketId: virtualSocketId, 
        expectedTargetSocketId: actualSocketId + 999 
    }));
    const deleteResponse1 = await onceMessageOfType(ws, 'virtualSocketDeleted');
    assert.equal(deleteResponse1.success, false);
    
    // Delete with correct expected target (should succeed)
    ws.send(JSON.stringify({ 
        type: 'deleteVirtualSocket', 
        virtualSocketId: virtualSocketId,
        expectedTargetSocketId: actualSocketId
    }));
    const deleteResponse2 = await onceMessageOfType(ws, 'virtualSocketDeleted');
    assert.equal(deleteResponse2.success, true);
});