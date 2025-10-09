// @ts-nocheck
import WebSocket from 'ws';
import os from 'node:os';

// Spawns many WebSocket connections (default 10_000) to a server and runs
// a request->broadcast->ack loop on each connection serially.
// Usage: node dist/examples/performance/client/client.js --url ws://host:3000 --conns 10000

function arg(name: string, def?: string) {
  const ix = process.argv.indexOf(`--${name}`);
  if (ix >= 0 && process.argv[ix + 1]) return process.argv[ix + 1];
  return process.env[name.toUpperCase()] || def;
}

const host = arg('host', '127.0.0.1')!;
const port = Number(arg('port', '3000')!);
const totalConns = Number(arg('conns', '10000'));

console.log(`[perf-client] connecting to ws://${host}:${port} through :${port + 15} conns=${totalConns}`);

// A simple connection manager that spreads connection establishment over time
// to avoid thundering herd. We create connections in batches.
const BATCH = 200; // connections per batch
const BATCH_DELAY = 25; // ms between batches

let opened = 0;
let subAcked = 0;
let acks = 0;
let nextIndex = 0;
let msgs = 0;

function openOne(i: number): void {
  const ws = new WebSocket(`ws://${host}:${port+(i%16)}`);
  let channel: string | undefined;

  ws.on('open', () => {
    opened++;
    ws.send(JSON.stringify({ type: 'sub' }));
  });

  ws.on('message', (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.type === 'sub-ack') {
        channel = msg.ch;
        subAcked++;
        // Start the request loop
        loop();
        return;
      }
      if (msg.type === 'ack') {
        acks++;
        // send next request
        setImmediate(loop);
        return;
      }
      msgs++;
    } catch {}
  });

  ws.on('error', () => {/* ignore */});

  function loop() {
    // Send a request that will cause server to broadcast to our channel, then ack back
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'req', channel }));
    }
  }
}

async function openAll() {
  while (nextIndex < totalConns) {
    const start = nextIndex;
    const end = Math.min(totalConns, start + BATCH);
    for (let i = start; i < end; i++) openOne(i);
    nextIndex = end;
    await new Promise((r) => setTimeout(r, BATCH_DELAY));
  }
}

// Stats
setInterval(() => {
  console.log(`[perf-client] opened=${opened} subAck=${subAcked} acks=${acks} msg=${msgs}`);
}, 10_000);

openAll().catch((e) => {
  console.error('[perf-client] error', e);
  process.exit(1);
});
