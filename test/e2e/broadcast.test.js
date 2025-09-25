const test = require('node:test');
const assert = require('node:assert');
const { createWebSocket, onceMessage, onceMessageOfType } = require('../helpers/testUtils.js');

test('broadcast to channel reaches subscribers (threads:0)', async () => {
  const a = await createWebSocket();
  const b = await createWebSocket();

  a.send(JSON.stringify({ type: 'sub', channel: 'room' }));
  b.send(JSON.stringify({ type: 'sub', channel: 'room' }));
  await Promise.all([onceMessage(a), onceMessage(b)]); // subscribed acks

  const received = onceMessage(b);
  a.send(JSON.stringify({ type: 'pub', channel: 'room', data: 'hello' }));

  const msg = await received;
  const parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'published');
  assert.equal(parsed.data, 'hello');

  a.close();
  b.close();
});

test('hasSubscriptions returns correct status', async () => {
  const a = await createWebSocket();
  const b = await createWebSocket();

  // Check channel has no subscriptions initially
  a.send(JSON.stringify({ type: 'hasSubscriptions', channel: 'test-room' }));
  let msg = await onceMessage(a);
  let parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'hasSubscriptions');
  assert.equal(parsed.channel, 'test-room');
  assert.equal(parsed.result, false);

  // Subscribe one client
  a.send(JSON.stringify({ type: 'sub', channel: 'test-room' }));
  await onceMessage(a); // subscribed ack

  // Check channel now has subscriptions
  a.send(JSON.stringify({ type: 'hasSubscriptions', channel: 'test-room' }));
  msg = await onceMessage(a);
  parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'hasSubscriptions');
  assert.equal(parsed.channel, 'test-room');
  assert.equal(parsed.result, true);

  // Subscribe second client
  b.send(JSON.stringify({ type: 'sub', channel: 'test-room' }));
  await onceMessage(b); // subscribed ack

  // Check channel still has subscriptions
  a.send(JSON.stringify({ type: 'hasSubscriptions', channel: 'test-room' }));
  msg = await onceMessage(a);
  parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'hasSubscriptions');
  assert.equal(parsed.channel, 'test-room');
  assert.equal(parsed.result, true);

  // Close one client
  b.close();
  
  // Give some time for cleanup
  await new Promise(resolve => setTimeout(resolve, 100));

  // Check channel still has subscriptions (client a is still connected)
  a.send(JSON.stringify({ type: 'hasSubscriptions', channel: 'test-room' }));
  msg = await onceMessage(a);
  parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'hasSubscriptions');
  assert.equal(parsed.channel, 'test-room');
  assert.equal(parsed.result, true);

  a.close();
});

test('multiple subscriptions to same channel by same socket are reference counted', async () => {
  const a = await createWebSocket();

  // First subscription should be new
  a.send(JSON.stringify({ type: 'sub', channel: 'multi-sub' }));
  let msg = await onceMessage(a);
  let parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'subscribed');
  assert.equal(parsed.channel, 'multi-sub');
  assert.equal(parsed.isNew, true);

  // Second subscription to same channel should increment ref count
  a.send(JSON.stringify({ type: 'sub', channel: 'multi-sub' }));
  msg = await onceMessage(a);
  parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'subscribed');
  assert.equal(parsed.channel, 'multi-sub');
  assert.equal(parsed.isNew, false);

  // Third subscription
  a.send(JSON.stringify({ type: 'sub', channel: 'multi-sub' }));
  msg = await onceMessage(a);
  parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'subscribed');
  assert.equal(parsed.channel, 'multi-sub');
  assert.equal(parsed.isNew, false);

  // Publish to channel - should receive message once despite multiple subscriptions
  const received = onceMessage(a);
  a.send(JSON.stringify({ type: 'pub', channel: 'multi-sub', data: 'test-multi' }));

  const pubMsg = await received;
  parsed = JSON.parse(pubMsg);
  assert.equal(parsed.type, 'published');
  assert.equal(parsed.data, 'test-multi');

  a.close();
});

test('unsubscribe decrements reference count and removes only when count reaches zero', async () => {
  const a = await createWebSocket();
  const b = await createWebSocket();

  // Subscribe three times
  for (let i = 0; i < 3; i++) {
    a.send(JSON.stringify({ type: 'sub', channel: 'ref-count' }));
    const msg = await onceMessage(a);
    const parsed = JSON.parse(msg);
    assert.equal(parsed.type, 'subscribed');
    assert.equal(parsed.channel, 'ref-count');
    assert.equal(parsed.isNew, i === 0); // First one is new, others are ref count increases
  }

  // Subscribe b once
  b.send(JSON.stringify({ type: 'sub', channel: 'ref-count' }));
  await onceMessage(b);

  // First unsubscribe should decrement ref count, not remove
  a.send(JSON.stringify({ type: 'unsub', channel: 'ref-count' }));
  let msg = await onceMessage(a);
  let parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'unsubscribed');
  assert.equal(parsed.channel, 'ref-count');
  assert.equal(parsed.wasRemoved, false);

  // Second unsubscribe should still not remove
  a.send(JSON.stringify({ type: 'unsub', channel: 'ref-count' }));
  msg = await onceMessage(a);
  parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'unsubscribed');
  assert.equal(parsed.channel, 'ref-count');
  assert.equal(parsed.wasRemoved, false);

  // Third unsubscribe should remove
  a.send(JSON.stringify({ type: 'unsub', channel: 'ref-count' }));
  msg = await onceMessage(a);
  parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'unsubscribed');
  assert.equal(parsed.channel, 'ref-count');
  assert.equal(parsed.wasRemoved, true);

  // Channel should still have subscriptions (b is still subscribed)
  a.send(JSON.stringify({ type: 'hasSubscriptions', channel: 'ref-count' }));
  msg = await onceMessage(a);
  parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'hasSubscriptions');
  assert.equal(parsed.result, true);

  a.close();
  b.close();
});

test('copySubscriptions increments reference counts and returns new socket IDs', async () => {
  const a = await createWebSocket();
  const b = await createWebSocket();

  // Subscribe a to channel1
  a.send(JSON.stringify({ type: 'sub', channel: 'channel1' }));
  await onceMessage(a);

  // Subscribe b to channel1 twice
  b.send(JSON.stringify({ type: 'sub', channel: 'channel1' }));
  await onceMessage(b);
  b.send(JSON.stringify({ type: 'sub', channel: 'channel1' }));
  await onceMessage(b);

  // Copy subscriptions from channel1 to channel2
  a.send(JSON.stringify({ type: 'copySubs', fromChannel: 'channel1', toChannel: 'channel2' }));
  let msg = await onceMessage(a);
  let parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'subsCopied');
  assert.equal(parsed.fromChannel, 'channel1');
  assert.equal(parsed.toChannel, 'channel2');
  assert(Array.isArray(parsed.newSocketIds));
  assert.equal(parsed.newSocketIds.length, 2); // Should contain both a and b's socket IDs

  // Copy again - should not have new socket IDs since ref counts will be incremented
  a.send(JSON.stringify({ type: 'copySubs', fromChannel: 'channel1', toChannel: 'channel2' }));
  msg = await onceMessage(a);
  parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'subsCopied');
  assert.equal(parsed.newSocketIds.length, 0); // No new socket IDs, just ref count increases

  // Publish to channel2 - both a and b should receive (a once, b once despite double subscription)
  const receivedA = onceMessageOfType(a, 'published');
  const receivedB = onceMessageOfType(b, 'published');
  a.send(JSON.stringify({ type: 'pub', channel: 'channel2', data: 'copied-test' }));

  const msgA = await receivedA;
  const msgB = await receivedB;
  assert.equal(msgA.data, 'copied-test');
  assert.equal(msgB.data, 'copied-test');

  a.close();
  b.close();
});

test('send to array of socket IDs', async () => {
  const a = await createWebSocket();
  const b = await createWebSocket();
  const c = await createWebSocket();

  // Get socket IDs
  const promiseA = onceMessage(a);
  const promiseB = onceMessage(b);
  const promiseC = onceMessage(c);
  a.send(JSON.stringify({ type: 'getSocketId' }));
  b.send(JSON.stringify({ type: 'getSocketId' }));
  c.send(JSON.stringify({ type: 'getSocketId' }));

  const socketIdMsgA = await promiseA;
  const socketIdMsgB = await promiseB;
  const socketIdMsgC = await promiseC;

  const socketIdA = JSON.parse(socketIdMsgA).socketId;
  const socketIdB = JSON.parse(socketIdMsgB).socketId;
  const socketIdC = JSON.parse(socketIdMsgC).socketId;

  // Send message to sockets A and C via array (skipping B)
  const receivedA = onceMessageOfType(a, 'directMessage');
  const receivedC = onceMessageOfType(c, 'directMessage');
  const sendResult = onceMessageOfType(a, 'sendResult');
  
  a.send(JSON.stringify({
    type: 'sendToSockets',
    socketIds: [socketIdA, socketIdC],
    data: 'array-message'
  }));

  // A and C should receive the message
  const msgA = await receivedA;
  const msgC = await receivedC;
  assert.equal(msgA.data, 'array-message');
  assert.equal(msgC.data, 'array-message');

  // Check that send returned the correct count (2 recipients)
  const result = await sendResult;
  assert.equal(result.count, 2, 'Send should return count of 2 for successful sends to A and C');

  // B should not receive anything (we'll test by trying to get a message with short timeout)
  let bReceivedMessage = false;
  const bReceivePromise = onceMessageOfType(b, 'directMessage', 100).then(() => {
    bReceivedMessage = true;
  }).catch(() => {
    // Expected - B should not receive the message
  });

  await bReceivePromise;
  assert.equal(bReceivedMessage, false, 'Socket B should not have received the array message');

  a.close();
  b.close();
  c.close();

});

test('subscribe with array of socket IDs', async () => {
  const a = await createWebSocket();
  const b = await createWebSocket();
  const c = await createWebSocket();

  // Get socket IDs
  const promiseA = onceMessage(a);
  const promiseB = onceMessage(b);
  const promiseC = onceMessage(c);
  a.send(JSON.stringify({ type: 'getSocketId' }));
  b.send(JSON.stringify({ type: 'getSocketId' }));
  c.send(JSON.stringify({ type: 'getSocketId' }));

  const socketIdMsgA = await promiseA;
  const socketIdMsgB = await promiseB;
  const socketIdMsgC = await promiseC;

  const socketIdA = JSON.parse(socketIdMsgA).socketId;
  const socketIdB = JSON.parse(socketIdMsgB).socketId;
  const socketIdC = JSON.parse(socketIdMsgC).socketId;

  // Subscribe multiple sockets to a channel using array
  a.send(JSON.stringify({
    type: 'subArray',
    socketIds: [socketIdA, socketIdB, socketIdC],
    channel: 'array-test-channel'
  }));

  // Should receive array subscription response
  const subResponse = await onceMessage(a);
  const parsed = JSON.parse(subResponse);
  assert.equal(parsed.type, 'subscribedArray');
  assert.equal(parsed.channel, 'array-test-channel');
  assert(Array.isArray(parsed.results));
  assert.equal(parsed.results.length, 3);
  // All should be new subscriptions (true)
  assert.equal(parsed.results[0], true);
  assert.equal(parsed.results[1], true);
  assert.equal(parsed.results[2], true);

  // Broadcast to the channel - all three should receive
  const receivedA = onceMessageOfType(a, 'published');
  const receivedB = onceMessageOfType(b, 'published');
  const receivedC = onceMessageOfType(c, 'published');

  a.send(JSON.stringify({ type: 'pub', channel: 'array-test-channel', data: 'array-sub-test' }));

  const msgA = await receivedA;
  const msgB = await receivedB;
  const msgC = await receivedC;
  
  assert.equal(msgA.data, 'array-sub-test');
  assert.equal(msgB.data, 'array-sub-test');
  assert.equal(msgC.data, 'array-sub-test');

  // Subscribe the same sockets again - should increment ref counts
  a.send(JSON.stringify({
    type: 'subArray',
    socketIds: [socketIdA, socketIdB],
    channel: 'array-test-channel'
  }));

  const subResponse2 = await onceMessage(a);
  const parsed2 = JSON.parse(subResponse2);
  assert.equal(parsed2.type, 'subscribedArray');
  assert.equal(parsed2.results.length, 2);
  // Should be false since they were already subscribed
  assert.equal(parsed2.results[0], false);
  assert.equal(parsed2.results[1], false);

  a.close();
  b.close();
  c.close();

});

test('unsubscribe based on another channel using negative delta', async () => {
  const a = await createWebSocket();
  const b = await createWebSocket();

  // Subscribe a to channel1 twice and channel2 once
  a.send(JSON.stringify({ type: 'sub', channel: 'channel1' }));
  await onceMessage(a);
  a.send(JSON.stringify({ type: 'sub', channel: 'channel1' }));
  await onceMessage(a);
  a.send(JSON.stringify({ type: 'sub', channel: 'channel2' }));
  await onceMessage(a);

  // Subscribe b to channel1 once and channel2 twice
  b.send(JSON.stringify({ type: 'sub', channel: 'channel1' }));
  await onceMessage(b);
  b.send(JSON.stringify({ type: 'sub', channel: 'channel2' }));
  await onceMessage(b);
  b.send(JSON.stringify({ type: 'sub', channel: 'channel2' }));
  await onceMessage(b);

  // Verify both are subscribed to channel2
  let received_a = onceMessageOfType(a, 'published');
  let received_b = onceMessageOfType(b, 'published');
  a.send(JSON.stringify({ type: 'pub', channel: 'channel2', data: 'before-unsub' }));
  await received_a;
  await received_b;

  // Unsubscribe all subscribers of channel1 from channel2 (delta=-1)
  a.send(JSON.stringify({ type: 'unsubFromChannel', fromChannel: 'channel1', toChannel: 'channel2', delta: 1 }));
  let msg = await onceMessage(a);
  let parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'unsubscribedFromChannel');
  assert.equal(parsed.fromChannel, 'channel1');
  assert.equal(parsed.toChannel, 'channel2');
  assert(Array.isArray(parsed.removedSocketIds));
  
  // Since a was subscribed twice to channel1 and once to channel2, and b was subscribed once to each:
  // - a: channel2 count goes from 1 to 0 (removed, so a's socketId should be in result)
  // - b: channel2 count goes from 2 to 1 (not removed, so b's socketId should NOT be in result)
  assert.equal(parsed.removedSocketIds.length, 1);

  // Verify: publish to channel2 - only b should receive (a was completely unsubscribed)
  received_b = onceMessageOfType(b, 'published');
  a.send(JSON.stringify({ type: 'pub', channel: 'channel2', data: 'after-unsub' }));
  
  // b should receive the message
  const msgB = await received_b;
  assert.equal(msgB.data, 'after-unsub');
  
  // a should NOT receive the message - wait a bit to ensure no message comes
  let receivedByA = false;
  a.on('message', () => { receivedByA = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(receivedByA, false);

  a.close();
  b.close();
});

test('send returns correct count for channel broadcasts', async () => {
  const a = await createWebSocket();
  const b = await createWebSocket();
  const c = await createWebSocket();

  // Subscribe a and b to the same channel, c remains unsubscribed
  a.send(JSON.stringify({ type: 'sub', channel: 'count-test-channel' }));
  await onceMessage(a);
  b.send(JSON.stringify({ type: 'sub', channel: 'count-test-channel' }));
  await onceMessage(b);

  // Prepare to receive messages
  const receivedA = onceMessageOfType(a, 'published');
  const receivedB = onceMessageOfType(b, 'published');
  const publishResult = onceMessageOfType(a, 'publishResult');

  // Broadcast to channel with returnCount flag
  a.send(JSON.stringify({ 
    type: 'pub', 
    channel: 'count-test-channel', 
    data: 'count-test',
    returnCount: true 
  }));

  // Both a and b should receive the message
  const msgA = await receivedA;
  const msgB = await receivedB;
  assert.equal(msgA.data, 'count-test');
  assert.equal(msgB.data, 'count-test');

  // Check that publish returned count of 2 (a and b subscribed)
  const result = await publishResult;
  assert.equal(result.count, 2, 'Publish should return count of 2 for subscribers a and b');

  a.close();
  b.close();
  c.close();
});

test('send returns 0 for non-existent socket IDs', async () => {
  const a = await createWebSocket();

  // Try to send to non-existent socket IDs
  const sendResult = onceMessageOfType(a, 'sendResult');
  
  a.send(JSON.stringify({
    type: 'sendToSockets',
    socketIds: [99999, 88888], // Non-existent socket IDs
    data: 'should-not-reach-anyone'
  }));

  // Check that send returned count of 0 (no recipients)
  const result = await sendResult;
  assert.equal(result.count, 0, 'Send to non-existent sockets should return count of 0');

  a.close();
});
