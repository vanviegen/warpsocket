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
});

test('copySubscriptions increments reference counts', async () => {
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
  assert.equal(parsed.hadNewInserts, true); // Should have new inserts

  // Copy again - should not have new inserts since ref counts will be incremented
  a.send(JSON.stringify({ type: 'copySubs', fromChannel: 'channel1', toChannel: 'channel2' }));
  msg = await onceMessage(a);
  parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'subsCopied');
  assert.equal(parsed.hadNewInserts, false); // No new inserts, just ref count increases

  // Publish to channel2 - both a and b should receive (a once, b once despite double subscription)
  const receivedA = onceMessageOfType(a, 'published');
  const receivedB = onceMessageOfType(b, 'published');
  a.send(JSON.stringify({ type: 'pub', channel: 'channel2', data: 'copied-test' }));

  const msgA = await receivedA;
  const msgB = await receivedB;
  assert.equal(msgA.data, 'copied-test');
  assert.equal(msgB.data, 'copied-test');
});
