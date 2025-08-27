const test = require('node:test');
const assert = require('node:assert');
const { createWebSocket, onceMessage, onceMessageOfType } = require('../helpers/testUtils.js');

test('createVirtualSocket returns a new socket ID', async () => {
    const ws = await createWebSocket();
    
    // Get the actual socket ID first
    ws.send(JSON.stringify({ type: 'getSocketId' }));
    const actualSocketResponse = await onceMessageOfType(ws, 'socketId');
    const actualSocketId = actualSocketResponse.socketId;
    
    // Create a virtual socket pointing to the actual socket
    ws.send(JSON.stringify({ type: 'createVirtualSocket', targetSocketId: actualSocketId }));
    const virtualSocketResponse = await onceMessageOfType(ws, 'virtualSocketCreated');
    
    assert.ok(typeof virtualSocketResponse.virtualSocketId === 'number');
    assert.notEqual(virtualSocketResponse.virtualSocketId, actualSocketId);
});

test('virtual socket can subscribe to channels and receive messages', async () => {
    const ws1 = await createWebSocket();
    const ws2 = await createWebSocket();
    
    // Get actual socket ID for ws1
    ws1.send(JSON.stringify({ type: 'getSocketId' }));
    const actualSocketResponse = await onceMessageOfType(ws1, 'socketId');
    const actualSocketId = actualSocketResponse.socketId;
    
    // Create virtual socket pointing to ws1
    ws1.send(JSON.stringify({ type: 'createVirtualSocket', targetSocketId: actualSocketId }));
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
    
    // Get actual socket ID
    ws.send(JSON.stringify({ type: 'getSocketId' }));
    const actualSocketResponse = await onceMessageOfType(ws, 'socketId');
    const actualSocketId = actualSocketResponse.socketId;
    
    // Create virtual socket
    ws.send(JSON.stringify({ type: 'createVirtualSocket', targetSocketId: actualSocketId }));
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
