const test = require('node:test');
const assert = require('node:assert');
const { createWebSocket, onceMessage, onceMessageOfType } = require('../helpers/testUtils.js');

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

test('virtual socket with user data includes _vsud in JSON messages', async () => {
    const ws1 = await createWebSocket();
    const ws2 = await createWebSocket();
    
    // Create virtual socket with user data
    const userData = 42;
    ws1.send(JSON.stringify({ type: 'createVirtualSocket', userData: userData }));
    const {virtualSocketId} = await onceMessageOfType(ws1, 'virtualSocketCreated');
    
    ws1.send(JSON.stringify({ type: 'sub', socketId: virtualSocketId, channel: 'test-vsud' }));
    await onceMessageOfType(ws1, 'subscribed');
    
    // Send message to channel - user data should be automatically included
    ws2.send(JSON.stringify({ type: 'pub', channel: 'test-vsud', data: 'hello' }));
    
    // Verify the user data is included in the message
    const message = await onceMessageOfType(ws1, 'published');
    assert.equal(message._vsud, userData);
    assert.equal(message.data, 'hello');
});

test('virtual socket with user data includes user data in binary messages', async () => {
    const ws1 = await createWebSocket();
    const ws2 = await createWebSocket();
    
    // Create virtual socket with user data
    const userData = 123;
    ws1.send(JSON.stringify({ type: 'createVirtualSocket', userData: userData }));
    const virtualResponse = await onceMessageOfType(ws1, 'virtualSocketCreated');
    const virtualSocketId = virtualResponse.virtualSocketId;
    
    ws1.send(JSON.stringify({ type: 'sub', socketId: virtualSocketId, channel: 'test-binary-vsud' }));
    await onceMessageOfType(ws1, 'subscribed');
    
    // Send binary message to channel
    ws2.send(JSON.stringify({ type: 'pub', channel: 'test-binary-vsud', data: 'binary-test', binary: true }));
    
    // The message should come as binary with the user data prefixed (as i32)
    const binaryMessage = await onceMessage(ws1);
    assert.ok(binaryMessage instanceof ArrayBuffer);
    
    const view = new DataView(binaryMessage);
    const prefixedUserData = view.getInt32(0, false); // big-endian, signed 32-bit
    assert.equal(prefixedUserData, userData);
    
    // The rest should be the original data
    const originalData = new TextDecoder().decode(binaryMessage.slice(4));
    assert.equal(originalData, 'binary-test');
});

test('virtual socket without user data receives messages normally', async () => {
    const ws1 = await createWebSocket();
    const ws2 = await createWebSocket();
    
    // Create virtual socket without user data
    ws1.send(JSON.stringify({ type: 'createVirtualSocket' }));
    const {virtualSocketId} = await onceMessageOfType(ws1, 'virtualSocketCreated');
    
    ws1.send(JSON.stringify({ type: 'sub', socketId: virtualSocketId, channel: 'test-no-vsud' }));
    await onceMessageOfType(ws1, 'subscribed');
    
    // Send message to channel
    ws2.send(JSON.stringify({ type: 'pub', channel: 'test-no-vsud', data: 'hello normal' }));
    
    // Message should be received without modification
    const message = await onceMessageOfType(ws1, 'published');
    assert.equal(message._vsud, undefined);
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