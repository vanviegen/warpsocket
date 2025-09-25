# WarpSocket

Node-API addon for writing high-performance multi-threaded WebSocket servers.

How does this work?

- WebSocket connections are accepted and managed by WarpSocket's multi-threaded Rust code.
- Incoming WebSocket messages (and other events) are handed off to JavaScript callback methods, allowing you to write application logic.
- Your application logic can call WarpSocket functions for:
  - Sending messages to specific WebSocket connections.
  - Subscribing connections to named channels.
  - Broadcasting messages to these named channels.
  - Attaching a token (meta information) to a connection.
- WebSocket connections are load-balanced across multiple JavaScript worker threads, with each connection pinned to one thread.

So what WarpSocket buys you compared to the standard Node.js WebSocket library (`ws`) is:
- More performant and memory efficient connection handling.
- Multi-threading, while still allowing you to efficiently send/broadcast to any WebSocket connection.
- A ready-made channel system for broadcasting messages to multiple subscribers.

Compared to [PushPin](https://github.com/fastly/pushpin), WarpSocket is:
- Only usable in a Node.js (or Bun) application.
- More lightweight and easier to deploy: just an npm install, no need to run a separate server process.
- Capable of running your business logic in parallel JavaScript threads.
- Very fast!

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

export async function handleTextMessage(text, socketId, token) {
  subscribe(socketId, 'general');
  send('general', `User ${socketId}: ${text}`);
}

export async function handleTextMessage(data, socketId, token) {
  console.error('Binary message received, but not handled');
}

export function handleClose(socketId, token) {
  console.log('Closed', socketId);
}
```

## Technical overview

When you `start()` a WarpSocket server from the main thread of your Node.js/Bun application, it will spawn a given number of JavaScript worker threads. Each of these worker threads will load a JavaScript file you specified (`workerPath`) and register itself with the native addon (written in Rust using NEON for the Node.js bindings). As these are actual threads, not processes, they share the same memory space. Though JavaScript objects are not shared between threads, the native addon does share its internal state (connections, channels, subscriptions, etc.) between all threads.

Besides firing up worker threads, when starting a WarpSocket server, the native addon will also bind to the specified address and start accepting WebSocket connections. It handles incoming connections and messages using asynchronous multi-threaded Rust code (using Tokio and Tungstenite). This should be fast!

Each incoming WebSocket connection is assigned a unique socket ID and coupled to a worker thread using a round-robin strategy. All events for that connection (open, incoming message, close) are then routed to that same worker thread. This means that your JavaScript code in the worker thread can maintain per-connection state in memory (e.g. in a Map keyed by socket ID) without needing to worry about synchronization between threads.

Events are scheduled to be run in the order that they came in (at least for messages coming from a single WebSocket) in the coupled worker's main thread. Worker handler functions may be synchronous or asynchronous. They may do whatever it is a backend server usually does: access databases, call other services, etc. Besides that, they may also call WarpSocket functions to send messages (to specific socket ids or channels) and subscribe to channels. Because WarpSocket data structures are shared between threads, a worker can subscribe to any channel and send messages to any channel/connection, even if that connection is coupled to a different worker thread.

Be aware that if you block a worker thread for too long, it will delay processing of all events for all connections assigned to that worker (as is usual in Node.js). In order to prevent an infinite loop (caused by a logic error) from bringing down the entire server, WarpSocket includes automatic worker thread monitoring and recovery. When a worker thread is unable to respond to a ping message within 3 seconds, it is considered unresponsive and will be terminated. All connections assigned to that worker are then closed (when they next send a message) with an appropriate error code, while other workers continue to operate normally. Client that get disconnected should be made to reconnect (they'll be assigned a new worker), reinitialize their state, and continue business as usual.

## Performance

The `examples/performance/` directory contains a simple benchmarking test. I'm planning to do a more thorough performance analysis on AWS soon (I've already had AI generate a Terraform config for it, but haven't had the heart to run it yet), but for now here's a workload I was able to sustain on my laptop:

- 60,000 concurrent connections, each subscribed to one of 6,000 channels
- ~70,000 incoming messages per second, delivered to JavaScript
- ~770,000 outgoing messages per second (for each incoming message, we do a reply and a broadcast to a channel of 10 random subscribers)
- ~50% utilization of my AMD Ryzen 9 6900HX CPU (the other 50% being the 6 clients generating the load)
- ~980 MB of resident RAM

I suspect that it will be possible to squeeze out more performance, using some profiling and optimization. But given the above numbers, I haven't felt the need yet.

## API Reference

WarpSocket provides a comprehensive TypeScript API for building real-time applications. The core functions allow you to start the server, send messages, handle channels, and manage authentication. All functions are fully typed and include detailed JSDoc documentation.

The following is auto-generated from `src/index.cts`:

### start · function

Starts a WebSocket server bound to the given address and (optionally)
spawns worker threads that receive and handle WebSocket events.

Notes:
- Multiple servers can be started concurrently on different addresses.
  Servers share global server state (channels, tokens, subscriptions, etc.)
  and the same worker pool.
- Calling `start` without `workerPath` will only work if `start` was already
  called earlier with a `workerPath`.

**Signature:** `(options: { bind: string; workerPath?: string; threads?: number; }) => Promise<void>`

**Parameters:**

- `options: { bind: string, workerPath?: string, threads?: number }` - - Configuration object:
- bind: Required. Address string to bind the server to (e.g. "127.0.0.1:8080").
- workerPath: Optional. Path (absolute or relative to process.cwd()) to the
 worker JavaScript module to load in threads. If provided,
 the module will be imported in each worker thread and any
 exported handlers will be registered with the native addon.
 Worker modules may export any subset of the `WorkerInterface`
 handlers. If `threads` is 0, the module will be registered
 on the main thread and no worker threads will be spawned.
- threads: Optional. Number of worker threads to spawn. When a positive
integer is provided, that number of Node.js `Worker` threads
are created and set up to handle WebSocket events. When omitted,
defaults to the number of CPU cores or 4, whichever is higher.

**Returns:** A Promise that resolves after worker threads (if any) have been
started and the native addon has been instructed to bind to the
address. The Promise rejects if worker initialization fails.

**Throws:**

- If `options` is missing or `options.bind` is not a string.

### unsubscribe · function

[object Object],[object Object],[object Object]

**Signature:** `(socketIdOrChannelName: string | number | number[] | ArrayBuffer | Uint8Array<ArrayBufferLike> | (string | number | ArrayBuffer | Uint8Array<ArrayBufferLike>)[], channelName: string | ... 1 more ... | Uint8Array<...>, delta?: number) => number[]`

**Parameters:**

- `socketIdOrChannelName: number | number[] | Uint8Array | ArrayBuffer | string | (number | Uint8Array | ArrayBuffer | string)[]` - a
- `channelName: Uint8Array | ArrayBuffer | string` - b
- `delta: number` (optional) - c

### copySubscriptions · function

**Signature:** `(fromChannelName: string | ArrayBuffer | Uint8Array<ArrayBufferLike>, toChannelName: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => number[]`

**Parameters:**

- `fromChannelName: Uint8Array | ArrayBuffer | string` - - The source channel name (Buffer, ArrayBuffer, or string).
- `toChannelName: Uint8Array | ArrayBuffer | string` - - The destination channel name (Buffer, ArrayBuffer, or string).

**Returns:** An array of socket IDs that were newly added to the destination channel. Sockets that were 
already subscribed (and had their reference count incremented) are not included.

### WorkerInterface · interface

Interface that worker threads must implement to handle WebSocket events.
All handler methods are optional - if not provided, the respective functionality will be unavailable.

#### workerInterface.handleOpen · member

Handles new WebSocket connections and can reject them. If not provided, all connections are accepted.

**Type:** `(socketId: number, ip: string, headers: Record<string, string>) => boolean`

#### workerInterface.handleTextMessage · member

Handles incoming WebSocket text messages from clients.

**Type:** `(data: string, socketId: number, token?: Uint8Array<ArrayBufferLike>) => void`

#### workerInterface.handleBinaryMessage · member

Handles incoming WebSocket binary messages from clients.

**Type:** `(data: Uint8Array<ArrayBufferLike>, socketId: number, token?: Uint8Array<ArrayBufferLike>) => void`

#### workerInterface.handleClose · member

Handles WebSocket connection closures.

**Type:** `(socketId: number, token?: Uint8Array<ArrayBufferLike>) => void`

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

When target is a virtual socket with user data (or a channel that has such a subscriber):
- For text messages: adds the user data as the `_vsud` property to JSON objects.
Example: `{"_vsud":12345,"your":"original","data":true}`.
- For binary messages: prefixes the user data as a 32-bit integer in network byte order.

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

### setToken · function

Associates an authentication token with a WebSocket connection. It will be passed along with all subsequent events for that connection.

**Signature:** `(socketId: number, token: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => void`

**Parameters:**

- `socketId` - - The unique identifier of the WebSocket connection.
- `token` - - The authentication token (Buffer, ArrayBuffer, or string). It will be converted to a (UTF-8 encoded) Uint8Array.

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

**Signature:** `(socketId: number, userData?: number) => number`

**Parameters:**

- `socketId` - - The identifier of the actual WebSocket connection or another virtual socket to point to.
- `userData` - - Optional user data (32-bit signed integer) that will be included in channel broadcasts to this virtual socket.
When provided, this data will be included in messages sent to channels this virtual socket subscribes to.
- Text messages will need to be JSON objects for this to work. They'll get a `_vsud` property added with the user data.
- Binary messages will be prefixed with a i32 in network order.

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

### WebSocket Authentication Example

```typescript
import { start, send, setToken, subscribe } from 'warpsocket';
import jwt from 'jsonwebtoken';

start({ bind: '0.0.0.0:3000', workerPath: './api-worker.js' });
```

`api-worker.js`:

```js
export function handleTextMessage(data, socketId, currentToken) {
  const message = JSON.parse(data);
  if (message.type === 'authenticate') {
    try {
      const decoded = jwt.verify(message.token, 'secret');
      setToken(socketId, JSON.stringify(message.token));
      subscribe(socketId, `user:${decoded.userId}`);
      send(socketId, JSON.stringify({ type: 'authenticated', userId: decoded.userId }));
    } catch (error) {
      send(socketId, JSON.stringify({ type: 'auth-error', body: 'Invalid token' }));
    }
    return;
  }
  if (!currentToken) {
    send(socketId, JSON.stringify({ type: 'auth-required', body: 'Please authenticate first' }));
    return;
  }
  const decoded = JSON.parse(currentToken);
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
