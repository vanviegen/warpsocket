# WarpSocket

Node-API addon for writing high-performance multi-threaded WebSocket servers.

How does this work?

- WebSocket connections are accepted and managed by WarpSocket's multi-threaded Rust code.
- Incoming WebSocket messages (and other events) are handed off to JavaScript callback methods, allowing you to write application logic.
- Your application logic can call WarpSocket functions for:
  - Sending messages to specific WebSocket connections.
  - Subscribing connections to named channels.
  - Broadcasting messages to these named channels.
- WebSocket connections are load-balanced across multiple JavaScript worker threads, with each connection pinned to one thread. For each connection, function handlers are called sequentially and in the order they were received in.

So what WarpSocket buys you compared to the standard Node.js WebSocket library (`ws`) is:
- More performant and memory efficient connection handling.
- Multi-threading, while still allowing you to efficiently send/broadcast to any WebSocket connection.
- A ready-made channel system for broadcasting messages to multiple subscribers.

Compared to [PushPin](https://github.com/fastly/pushpin), WarpSocket is:
- Only usable in a Node.js (or Bun) application.
- More lightweight and easier to deploy: just an npm install, no need to run a separate server process.
- Capable of running your business logic in parallel JavaScript threads.
- Very fast!

Bonus features:
- Very fast shared in-memory key/value store for coordination between worker threads.
- Virtual sockets that can point to actual WebSocket connections or other virtual sockets, allowing for convenient bulk unsubscription and message prefixing.
- Automatic worker thread monitoring and recovery to prevent infinite loops from bringing down the entire server.

## Quick Start

### Installation

```sh
npm install warpsocket
```

Requirements:

- **Node.js**: Version 18 or higher (or Bun).
- **Rust**: Unless you're on X64 Linux, for which a prebuilt binary is provided, a recent Rust toolchain (rustc + cargo) is required to build the project. The project has been tested with Rust 1.89.

### Basic Usage

```typescript
import { start, send, subscribe } from 'warpsocket';

// Start the server and point it at your worker module (defaults to one worker thread per CPU core)
start({ bind: '0.0.0.0:3000', workerPath: './my-worker.js' });
```

Create `my-worker.js` exporting any of the optional handlers:

```js
export function handleOpen(socketId, ip, headers) {
  console.log(`New connection ${socketId} from ip=${ip} origin=${headers.origin}`);
  return true; // accept
}

export async function handleTextMessage(text, socketId) {
  subscribe(socketId, 'general');
  send('general', `User ${socketId}: ${text}`);
}

export async function handleTextMessage(data, socketId) {
  console.error('Binary message received, but not handled');
}

export function handleClose(socketId) {
  console.log('Closed', socketId);
}
```

## Technical overview

When you `start()` a WarpSocket server from the main thread of your Node.js/Bun application, it will spawn a given number of JavaScript worker threads. Each of these worker threads will load a JavaScript file you specified (`workerPath`) and register itself with the native addon (written in Rust using NEON for the Node.js bindings). As these are actual threads, not processes, they share the same memory space. Though JavaScript objects are not shared between threads, the native addon does share its internal state (connections, channels, subscriptions, etc.) between all threads.

Besides firing up worker threads, when starting a WarpSocket server, the native addon will also bind to the specified address and start accepting WebSocket connections. It handles incoming connections and messages using asynchronous multi-threaded Rust code (using Tokio and Tungstenite). This should be fast!

Each incoming WebSocket connection is assigned a unique socket ID and coupled to a worker thread using a round-robin strategy. All events for that connection (open, incoming message, close) are then routed to that same worker thread. This means that your JavaScript code in the worker thread can maintain per-connection state in memory (e.g. in a Map keyed by socket ID) without needing to worry about synchronization between threads. 

Events are scheduled to be run sequentially and in the order that they came in (at least for messages coming from a single WebSocket) in the coupled worker's main thread. Worker handler functions may be synchronous or asynchronous (in which case they're awaited). They may do whatever it is a backend server usually does: access databases, call other services, etc. Besides that, they may also call WarpSocket functions to send messages (to specific socket ids or channels) and subscribe to channels. Because WarpSocket data structures are shared between threads, a worker can subscribe to any channel and send messages to any channel/connection, even if that connection is coupled to a different worker thread.

Be aware that if you block a worker thread for too long, it will delay processing of all events for all connections assigned to that worker (as is usual in Node.js). In order to prevent an infinite loop (caused by a logic error) from bringing down the entire server, WarpSocket includes automatic worker thread monitoring and recovery. When a worker thread is unable to respond to a ping message within 3 seconds, it is considered unresponsive and will be terminated. All connections assigned to that worker are then closed (when they next send a message) with an appropriate error code, while other workers continue to operate normally. Client that get disconnected should be made to reconnect (they'll be assigned a new worker), reinitialize their state, and continue business as usual.

Async handlers are also time-limited: it it doesn't complete within 5 seconds, WarpSocket gives up waiting and closes the connection with an error code. This is to prevent your application from becoming completely unresponsive for a given client due to a long-running/broken async operations (that all other requests will wait for). Silently dropping the message might be dangerous, so instead the connection is closed, and it's up to the client to reconnect and reinitialize its state.

## Performance

The `examples/performance/` directory contains a simple benchmarking test. I'm planning to do a more thorough performance analysis on AWS soon (I've already had AI generate a Terraform config for it, but haven't had the heart to run it yet), but for now here's a workload I was able to sustain on my laptop:

- 60,000 concurrent connections over localhost TCP, each subscribed to one channel shared by 10 connections
- ~120,000 incoming messages per second, delivered to JavaScript
- ~1,300,000 outgoing messages per second (for each incoming message, we do a reply and a broadcast to a channel of 10 random subscribers)
- ~50% utilization of my AMD Ryzen 9 6900HX CPU (the other 50% being the 6 clients generating the load)
- ~1600 MB of resident RAM

I suspect that it will be possible to squeeze out more performance, using some profiling and optimization. But given the above numbers, I haven't felt the need yet.

## API Reference

WarpSocket provides a comprehensive TypeScript API for building real-time applications. The core functions allow you to start the server, send messages, handle channels, and manage authentication. All functions are fully typed and include detailed JSDoc documentation.

The following is auto-generated from `src/index.cts`:

### start · function

Starts a WebSocket server bound to the given address and spawns worker threads
that handle WebSocket events.

**Signature:** `(options: { bind: string | string[]; workerPath?: string; threads?: number; workerArg?: any; }) => Promise<void>`

**Parameters:**

- `options: { bind: string | string[], workerPath?: string, threads?: number, workerArg?: any }` - - Configuration object:
* bind: Required. Address string to bind the server to (e.g. "127.0.0.1:8080"),
or an array of such strings to bind multiple addresses.
* workerPath: Required. Path (absolute or relative to process.cwd()) to the
 worker JavaScript module. This module will be imported in each
 worker thread and its exported handlers will be registered with
 the native addon. Worker modules may export any subset of the
 `WorkerInterface` handlers.
* threads: Optional. Number of worker threads to spawn. When a positive
integer is provided, that number of Node.js `Worker` threads
are created and set up to handle WebSocket events. When omitted,
defaults to the number of CPU cores or 4, whichever is higher.
* workerArg: Optional. Argument to pass to the handleStart() method of
worker modules, if they implement it. This allows passing
initialization data or configuration to workers.

**Returns:** A Promise that resolves after worker threads (if any) have been
started and the native addon has been instructed to bind to the
address. The Promise rejects if worker initialization fails.

**Throws:**

- If `options` is or the `bind` and `workerPath` properties are 
missing or invalid, or if already started.

### unsubscribe · function

Exactly the same as `subscribe`, only with a negative delta (defaulting to 1, which means a single unsubscribe, or a subscribe with delta -1).

**Signature:** `(socketIdOrChannelName: string | number | number[] | ArrayBuffer | Uint8Array<ArrayBufferLike> | (string | number | ArrayBuffer | Uint8Array<ArrayBufferLike>)[], channelName: string | ... 1 more ... | Uint8Array<...>, delta?: number) => number[]`

**Parameters:**

- `socketIdOrChannelName: number | number[] | Uint8Array | ArrayBuffer | string | (number | Uint8Array | ArrayBuffer | string)[]`
- `channelName: Uint8Array | ArrayBuffer | string`
- `delta: number` (optional)

### copySubscriptions · function

**DEPRECATED:** Use subscribe(fromChannelName, toChannelName) instead.

Copies all subscribers from one channel to another channel. Uses reference counting - if a subscriber 
is already subscribed to the destination channel, their reference count will be incremented instead 
of creating duplicate subscriptions.

**Signature:** `(fromChannelName: string | ArrayBuffer | Uint8Array<ArrayBufferLike>, toChannelName: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => number[]`

**Parameters:**

- `fromChannelName: Uint8Array | ArrayBuffer | string` - - The source channel name (Buffer, ArrayBuffer, or string).
- `toChannelName: Uint8Array | ArrayBuffer | string` - - The destination channel name (Buffer, ArrayBuffer, or string).

**Returns:** An array of socket IDs that were newly added to the destination channel. Sockets that were 
already subscribed (and had their reference count incremented) are not included.

### WorkerInterface · interface

Interface that worker threads must implement to handle WebSocket events.
All handler methods are optional - if not provided, the respective functionality will be unavailable.

#### workerInterface.handleStart · member

Called when the worker is starting up, before registering with the native addon.
This allows for initialization logic that needs to run before handling WebSocket events.

**Type:** `(workerArg?: any) => void | Promise<void>`

#### workerInterface.handleOpen · member

Handles new WebSocket connections and can reject them. If not provided, all connections are accepted.

**Type:** `(socketId: number, ip: string, headers: Record<string, string>) => boolean | Promise<boolean>`

#### workerInterface.handleTextMessage · member

Handles incoming WebSocket text messages from clients.

**Type:** `(data: string, socketId: number) => void | Promise<void>`

#### workerInterface.handleBinaryMessage · member

Handles incoming WebSocket binary messages from clients.

**Type:** `(data: Uint8Array<ArrayBufferLike>, socketId: number) => void | Promise<void>`

#### workerInterface.handleClose · member

Handles WebSocket connection closures.

**Type:** `(socketId: number) => void | Promise<void>`

### send · function

Sends data to a specific WebSocket connection, multiple connections, or broadcasts to all subscribers of a channel.

**Signature:** `(target: string | number | number[] | ArrayBuffer | Uint8Array<ArrayBufferLike> | (string | number | ArrayBuffer | Uint8Array<ArrayBufferLike>)[], data: string | ... 1 more ... | Uint8Array<...>) => number`

**Parameters:**

- `target` - - The target for the message: 
- A socket ID (number): sends to that specific socket
- A channel name (Buffer, ArrayBuffer, or string): broadcasts to all subscribers of that channel
- An array of socket IDs and/or channel names: sends to each socket and broadcasts to each channel
- `data` - - The data to send (Buffer, ArrayBuffer, or string).

**Returns:** the number of recipients that got sent the message.

When target is a virtual socket with user prefix (or a channel that has such a subscriber), that prefix is prepended to the message. In case of a text message, the prefix bytes are assumed to be valid UTF-8.

When target is an array, the message is sent to each target in the array.

### subscribe · function

Subscribes one or more WebSocket connections to a channel, or copies subscriptions from one channel to another.
Multiple subscriptions to the same channel by the same connection are reference-counted.

**Signature:** `(socketIdOrChannelName: string | number | number[] | ArrayBuffer | Uint8Array<ArrayBufferLike> | (string | number | ArrayBuffer | Uint8Array<ArrayBufferLike>)[], channelName: string | ... 1 more ... | Uint8Array<...>, delta?: number) => number[]`

**Parameters:**

- `socketIdOrChannelName` - - Can be:
- A single socket ID (number): applies delta to that socket's subscription
- An array of socket IDs (number[]): applies delta to all sockets' subscriptions
- A channel name (Buffer/ArrayBuffer/string): applies delta to all subscribers of this source channel
- An array mixing socket IDs and channel names: applies delta to sockets and source channel subscribers
- `channelName` - - The target channel name (Buffer, ArrayBuffer, or string).
- `delta` - - Optional. The amount to change the subscription count by (default: 1). 
Positive values add subscriptions, negative values remove them. When the count reaches zero, the subscription is removed.

**Returns:** An array of socket IDs that were affected by the operation:
- For positive delta: socket IDs that became newly subscribed (reference count went from 0 to positive)
- For negative delta: socket IDs that became completely unsubscribed (reference count reached 0)

### hasSubscriptions · function

Checks if a channel has any subscribers.

**Signature:** `(channelName: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => boolean`

**Parameters:**

- `channelName` - - The name of the channel to check (Buffer, ArrayBuffer, or string).

**Returns:** True if the channel has subscribers, false otherwise.

### createVirtualSocket · function

Creates a virtual socket that points to an actual WebSocket connection.
Virtual sockets can be subscribed to channels, and messages will be relayed to the underlying actual socket.
This allows for convenient bulk unsubscription by deleting the virtual socket.
Virtual sockets can also point to other virtual sockets, creating a chain that resolves to an actual socket.

**Signature:** `(socketId: number, userPrefix?: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => number`

**Parameters:**

- `socketId` - - The identifier of the actual WebSocket connection or another virtual socket to point to.
- `userPrefix` - - Optional user prefix (up to 15 bytes) that will be prepended to all messages sent to this virtual socket (possibly through a channel). For text messages, this prefix is assumed to be valid UTF-8.

**Returns:** The unique identifier of the newly created virtual socket, which can be used just like another socket.

### deleteVirtualSocket · function

Deletes a virtual socket and unsubscribes it from all channels.
This is a convenient way to bulk-unsubscribe a virtual socket from all its channels at once.

**Signature:** `(virtualSocketId: number, expectedTargetSocketId?: number) => boolean`

**Parameters:**

- `virtualSocketId` - - The unique identifier of the virtual socket to delete.
- `expectedTargetSocketId` - - Optional. If provided, the virtual socket will only be deleted 
if it points to this specific target socket ID. This can help prevent unauthorized unsubscribes.

**Returns:** true if the virtual socket was deleted, false if it was not found or target didn't match.

### getKey · function

Reads the raw bytes stored for a key in the shared in-memory store.

**Signature:** `(key: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => Uint8Array<ArrayBufferLike>`

**Parameters:**

- `key` - - Key to read (Buffer, ArrayBuffer, or string).

**Returns:** A Uint8Array when the key exists, or undefined otherwise.

### setKey · function

Stores or deletes a value in the shared key/value store.

**Signature:** `(key: string | ArrayBuffer | Uint8Array<ArrayBufferLike>, value?: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => Uint8Array<...>`

**Parameters:**

- `key` - - Key to upsert (Buffer, ArrayBuffer, or string).
- `value` - - Optional value to store. Pass `undefined` to delete the key instead.

**Returns:** The previous value as a Uint8Array when the key existed, or undefined if it did not.

### setKeyIf · function

Atomically updates a key only when its current value matches the expected check value.

**Signature:** `(key: string | ArrayBuffer | Uint8Array<ArrayBufferLike>, newValue?: string | ArrayBuffer | Uint8Array<ArrayBufferLike>, checkValue?: string | ... 1 more ... | Uint8Array<...>) => boolean`

**Parameters:**

- `key` - - Key to update (Buffer, ArrayBuffer, or string).
- `newValue` - - Optional replacement value. Pass `undefined` to delete the key on success.
- `checkValue` - - Optional expected value. Pass `undefined` to require that the key is absent.

**Returns:** true when the compare-and-set succeeds, false otherwise.

## Examples

### Chat Server

```typescript
import { start, send, subscribe, unsubscribe } from 'warpsocket';

start({ bind: '0.0.0.0:3000', workerPath: './chat-worker.js' });
```

`chat-worker.js`:

```js
export function handleTextMessage(data, socketId) {
  const message = JSON.parse(data);
  switch (message.type) {
    case 'join':
      subscribe(socketId, message.room);
      send(message.room, JSON.stringify({ type: 'user-joined', userId: socketId, room: message.room }));
      break;
    case 'leave':
      unsubscribe(socketId, message.room);
      send(message.room, JSON.stringify({ type: 'user-left', userId: socketId, room: message.room }));
      break;
    case 'message':
      send(message.room, JSON.stringify({ type: 'chat-message', userId: socketId, text: message.text, timestamp: Date.now() }));
      break;
  }
};
```

## Development

### How to build

- `npm run build`: Builds TypeScript files to JavaScript in `dist/` and builds the native addon (see below).
- `npm run build:native`: Builds only the native addon. This creates `build/<platform>-<arch>.node` using your local Rust toolchain. To build a debug binary, run: `npm run build:native -- --debug`.
- `npm run docs`: Updates the reference documentation section of README.md based on `src/index.cts`.

### End-to-end tests

The test suite consists of end-to-end tests that start a real server instance and connect to it using Node.js WebSocket clients. The tests are located in the `test/e2e/` directory and can be run with:

```sh
npm test
```

### Development Workflow

1. **Make changes** to the Rust code in `crates/warpsocket/src/lib.rs` or TypeScript code in `src/`
2. **Build the project** with `npm run debug` for development or `npm run build` for production
3. **Test your changes** by creating additional tests in `test/e2e/` and running them with `npm test`
4. **Run tests** with `npm test` to ensure everything works correctly
5. **Update reference docs** in README.md using `npm run docs` if you've changed TypeScript interfaces or JSDoc comments

### Running the chat example

The project includes example code to help you get started:

```sh
# Build and run the example server
npm run build && node dist/examples/chat/example.ts

# Or without compilation step (if using bun or a very recent Node.js)
bun examples/chat/example.ts

# Point your browser at http://localhost:3000
```

### Running the performance test

Start the server using:

```sh
node dist/examples/performance/server/server.js --bind 0.0.0.0:3000 --threads 16
```

Start multiple servers, preferably on different machines:

```sh
node dist/examples/performance/client/client.js --host 127.0.0.1 --port 3000 --conns 10000
```


## Project Layout

The directory structure of this project is:

```
warpsocket/
├── Cargo.toml
├── README.md
├── dist/                  # Generated TypeScript output
├── src/                   # TypeScript source files
|   ├── index.cts          # CommonJS entry point (includes Worker spawning logic)
|   ├── index.mts          # ESM entry point (just loads the CJS entry point)
|   └── addon-loader.cts   # Loader for platform-specific binaries
├── crates/                # Rust source code
|   └── warpsocket/
|       └── src/
|           └── lib.rs     # Main Rust implementation
├── examples/              # Example applications
|   ├── chat/              # Chat example
|   │   ├── example.ts     # Server example (sets up WarpSocket and static HTTP)
|   │   ├── worker.ts      # Event-handling logic for the example, ran in worker threads
|   │   └── client/        # Client-side code for the example
├── build/                 # Path for native addon binaries
├── build-addon.js         # Build script for the native addon
├── package.json
└── target/                # Intermediate Rust build artifacts
```

## License

ISC - see `LICENSE.txt` file for details.
