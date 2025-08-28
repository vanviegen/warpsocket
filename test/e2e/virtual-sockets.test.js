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

test('sendToChannel with includeSocketId adds _vsi to JSON messages', async () => {
    const ws1 = await createWebSocket();
    const ws2 = await createWebSocket();
    
    // Create virtual socket and subscribe to channel
    ws1.send(JSON.stringify({ type: 'createVirtualSocket' }));
    const {virtualSocketId} = await onceMessageOfType(ws1, 'virtualSocketCreated');
    
    ws1.send(JSON.stringify({ type: 'sub', socketId: virtualSocketId, channel: 'test-vsi' }));
    await onceMessageOfType(ws1, 'subscribed');
    
    // Send message with socket ID prefix enabled
    ws2.send(JSON.stringify({ type: 'pub', channel: 'test-vsi', data: 'hello', withSocketId: true }));
    
    // Verify the virtual socket ID is included in the message
    const message = await onceMessageOfType(ws1, 'published');
    assert.ok(message._vsi);
    assert.equal(message._vsi, virtualSocketId);
    assert.equal(message.data, 'hello');
});

test('sendToChannel with includeSocketId adds socket ID to binary messages', async () => {
    const ws1 = await createWebSocket();
    const ws2 = await createWebSocket();
    
    // Create virtual socket and subscribe to channel
    ws1.send(JSON.stringify({ type: 'createVirtualSocket' }));
    const virtualResponse = await onceMessageOfType(ws1, 'virtualSocketCreated');
    const virtualSocketId = virtualResponse.virtualSocketId;
    
    ws1.send(JSON.stringify({ type: 'sub', socketId: virtualSocketId, channel: 'test-binary-vsi' }));
    await onceMessageOfType(ws1, 'subscribed');
    
    // Send binary message with socket ID prefix
    ws2.send(JSON.stringify({ type: 'pub', channel: 'test-binary-vsi', data: 'binary-test', binary: true, withSocketId: true }));
    
    // The message should come as binary with the virtual socket ID prefixed
    const binaryMessage = await onceMessage(ws1);
    assert.ok(binaryMessage instanceof ArrayBuffer);
    
    const view = new DataView(binaryMessage);
    const prefixedSocketId = view.getBigUint64(0, false); // big-endian
    assert.equal(Number(prefixedSocketId), virtualSocketId);
    
    // The rest should be the original JSON message
    const originalData = new TextDecoder().decode(binaryMessage.slice(8));
    assert.equal(originalData, 'binary-test');
});
