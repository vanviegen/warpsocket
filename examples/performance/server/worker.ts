import { send, sendToChannel, subscribe } from 'warpws';

// Each worker uses a unique prefix so their channel namespaces don't collide
// The native side runs N workers; we can't directly know the index here, so we
// derive a unique-ish prefix from threadId and pid.
import { threadId } from 'node:worker_threads';

// Request protocol (client -> server) is JSON lines (one message per WS frame):
// { type: 'sub' }  -> server subscribes this socket to a channel, 10 members per channel
// { type: 'req', channel?: string } -> server broadcasts a short message to the channel that this socket is in (or provided), then replies to the requester with { type: 'ack' }
// The client waits for ack before sending the next request.

type Req = { type: 'sub' } | { type: 'req'; channel?: string };

const prefix = `wrkr-${process.pid}-${threadId}`;
let currentBucket = 0;
let inBucketCount = 0;
const BUCKET_SIZE = 10;

// Stats
let subscriberCount = 0;
let handledSinceLastTick = 0;

function nextChannel(): string {
    if (inBucketCount >= BUCKET_SIZE) {
        currentBucket++;
        inBucketCount = 0;
    }
    inBucketCount++;
    return `${prefix}-ch-${currentBucket}`;
}

export function handleTextMessage(data: string, socketId: number) {
    const msg: Req = JSON.parse(data);
    if (msg.type === 'sub') {
        const ch = nextChannel();
        subscribe(socketId, ch);
        subscriberCount++;
        // Reply to confirm subscription
        send(socketId, JSON.stringify({ type: 'sub-ack', ch }));
        return;
    }
    if (msg.type === 'req') {
        const ch = msg.channel ?? `${prefix}-ch-${Math.floor(Math.random()*currentBucket)}`;
        // Broadcast a small payload
        const payload = JSON.stringify({ type: 'evt', t: 'This is a message to my dear clients' });
        sendToChannel(ch, payload);
        handledSinceLastTick++;
        // Acknowledge to requester
        send(socketId, JSON.stringify({ type: 'ack' }));
        return;
    }
}

// Periodic stats
setInterval(() => {
    const count = handledSinceLastTick;
    handledSinceLastTick = 0;
    console.log(`[perf-worker ${prefix}] subscribers=${subscriberCount} handled/10s=${count}`);
}, 10_000);
