# WarpWS

Node-API addon for writing high-performance multi-threaded WebSocket servers.

How does this work?

- WebSocket connections are accepted and managed by WarpWS's multi-threaded Rust code.
- Incoming WebSocket messages (and other events) are handed off to JavaScript callback methods, allowing you to write application logic.
- Your application logic can call WarpWS functions for:
  - Sending messages to specific WebSocket connections.
  - Subscribing connections to named channels.
  - Broadcasting messages to these named channels.
  - Attaching a token (meta information) to a connection.
- JavaScript callbacks are load-balanced across multiple JavaScript worker threads.

So what WarpWS buys you compared to the standard Node.js WebSocket library (`ws`) is:
- More performant and memory efficient connection handling.
- Multi-threading, while still allowing you to efficiently send/broadcast to any WebSocket connection.
- A ready-made channel system for broadcasting messages to multiple subscribers.

Compared to [PushPin](https://github.com/fastly/pushpin), WarpWS is:
- Only usable in a Node.js (or Bun) application.
- More lightweight and easier to deploy: just an npm install, no need to run a separate server process.
- Capable of running your business logic in parallel JavaScript threads.
- Very fast!

## Quick Start

### Installation

```sh
npm install warpws
```

Requirements:

- **Node.js**: Version 18 or higher (or Bun).
- **Rust**: Unless you're on X64 Linux, for which a prebuilt binary is provided, a recent Rust toolchain (rustc + cargo) is required to build the project. The project has been tested with Rust 1.89.

### Basic Usage

```typescript
import { start, sendToChannel, subscribe } from 'warpws';

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
  sendToChannel('general', `User ${socketId}: ${text}`);
}

export async function handleTextMessage(data, socketId, token) {
  console.error('Binary message received, but not handled');
}

export function handleClose(socketId, token) {
  console.log('Closed', socketId);
}
```

## Performance

The `examples/performance/` directory contains a simple benchmarking test. I'm planning to do a more thorough performance analysis on AWS soon (I've already had AI generate a Terraform config for it, but haven't had the heart to run it yet), but for now here's a workload I was able to sustain on my laptop:

- 60,000 concurrent connections, each subscribed to one of 6,000 channels
- ~70,000 incoming messages per second, delivered to JavaScript
- ~770,000 outgoing messages per second (for each incoming message, we do a reply and a broadcast to a channel of 10 random subscribers)
- ~50% utilization of my AMD Ryzen 9 6900HX CPU (the other 50% being the 6 clients generating the load)
- ~980 MB of resident RAM

I suspect that it will be possible to squeeze out more performance, using some profiling and optimization. But given the above numbers, I haven't felt the need yet.

## API Reference

WarpWS provides a comprehensive TypeScript API for building real-time applications. The core functions allow you to start the server, send messages, handle channels, and manage authentication. All functions are fully typed and include detailed JSDoc documentation.

The following is auto-generated from `src/index.cts`:

### start · function

Starts a WebSocket server bound to the given address and (optionally)
spawns worker threads that receive and handle WebSocket events.

Notes:
- Multiple servers can be started concurrently on different addresses.
  Servers share global server state (channels, tokens, subscriptions, etc.)
  and the same worker pool.
- Calling `start` without `workerPath` requires that at least one worker
  has been registered previously via `registerWorkerThread`.

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
- threads: Optional. Number of worker threads to spawn. When 0 the
worker module is registered on the main thread. When a positive
integer is provided, that number of Node.js `Worker` threads
are created and set up to handle WebSocket events. When omitted,
defaults to the number of CPU cores or 4, whichever is higher.

**Returns:** A Promise that resolves after worker threads (if any) have been
started and the native addon has been instructed to bind to the
address. The Promise rejects if worker initialization fails.

**Throws:**

- If `options` is missing or `options.bind` is not a string.

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

### registerWorkerThread · function

Manually registers a worker thread with the server to handle WebSocket messages.
This function is normally not needed, as worker threads can be automatically registered by calling `start` with a `workerPath`.

**Signature:** `(worker: WorkerInterface) => void`

**Parameters:**

- `worker` - - Worker interface implementation with optional handlers.

### send · function

Sends data to a specific WebSocket connection.

**Signature:** `(socketId: number, data: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => void`

**Parameters:**

- `socketId` - - The unique identifier of the WebSocket connection.
- `data` - - The data to send (Buffer, ArrayBuffer, or string).

### sendToChannel · function

Broadcasts data to all subscribers of a specific channel.

**Signature:** `(channelName: string | ArrayBuffer | Uint8Array<ArrayBufferLike>, data: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => void`

**Parameters:**

- `channelName` - - The name of the channel to broadcast to (Buffer, ArrayBuffer, or string).
- `data` - - The data to broadcast (Buffer, ArrayBuffer, or string).

### subscribe · function

Subscribes a WebSocket connection to a channel.

**Signature:** `(socketId: number, channelName: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => boolean`

**Parameters:**

- `socketId` - - The unique identifier of the WebSocket connection.
- `channelName` - - The name of the channel to subscribe to (Buffer, ArrayBuffer, or string).

**Returns:** true if the subscription was added, false if already subscribed.

### unsubscribe · function

Unsubscribes a WebSocket connection from a channel.

**Signature:** `(socketId: number, channelName: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => boolean`

**Parameters:**

- `socketId` - - The unique identifier of the WebSocket connection.
- `channelName` - - The name of the channel to unsubscribe from (Buffer, ArrayBuffer, or string).

**Returns:** true if the subscription was removed, false if not subscribed.

### setToken · function

Associates an authentication token with a WebSocket connection. It will be passed along with all subsequent events for that connection.

**Signature:** `(socketId: number, token: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => void`

**Parameters:**

- `socketId` - - The unique identifier of the WebSocket connection.
- `token` - - The authentication token (Buffer, ArrayBuffer, or string). It will be converted to a (UTF-8 encoded) Uint8Array.

### copySubscriptions · function

Copies all subscribers from one channel to another channel.

**Signature:** `(fromChannelName: string | ArrayBuffer | Uint8Array<ArrayBufferLike>, toChannelName: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => void`

**Parameters:**

- `fromChannelName` - - The source channel name (Buffer, ArrayBuffer, or string).
- `toChannelName` - - The destination channel name (Buffer, ArrayBuffer, or string).

## Examples

### Chat Server

```typescript
import { start, sendToChannel, subscribe, unsubscribe } from 'warpws';

start({ bind: '0.0.0.0:3000', workerPath: './chat-worker.js' });
```

`chat-worker.js`:

```js
export function handleTextMessage(data, socketId) {
  const message = JSON.parse(data);
  switch (message.type) {
    case 'join':
      subscribe(socketId, message.room);
      sendToChannel(message.room, JSON.stringify({ type: 'user-joined', userId: socketId, room: message.room }));
      break;
    case 'leave':
      unsubscribe(socketId, message.room);
      sendToChannel(message.room, JSON.stringify({ type: 'user-left', userId: socketId, room: message.room }));
      break;
    case 'message':
      sendToChannel(message.room, JSON.stringify({ type: 'chat-message', userId: socketId, text: message.text, timestamp: Date.now() }));
      break;
  }
};
```

### WebSocket Authentication Example

```typescript
import { start, send, setToken, subscribe } from 'warpws';
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

1. **Make changes** to the Rust code in `crates/warpws/src/lib.rs` or TypeScript code in `src/`
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
warpws/
├── Cargo.toml
├── README.md
├── dist/                  # Generated TypeScript output
├── src/                   # TypeScript source files
|   ├── index.cts          # CommonJS entry point (includes Worker spawning logic)
|   ├── index.mts          # ESM entry point (just loads the CJS entry point)
|   └── addon-loader.cts   # Loader for platform-specific binaries
├── crates/                # Rust source code
|   └── warpws/
|       └── src/
|           └── lib.rs     # Main Rust implementation
├── examples/              # Example applications
|   ├── chat/              # Chat example
|   │   ├── example.ts     # Server example (sets up WarpWS and static HTTP)
|   │   ├── worker.ts      # Event-handling logic for the example, ran in worker threads
|   │   └── client/        # Client-side code for the example
├── build/                 # Path for native addon binaries
├── build-addon.js         # Build script for the native addon
├── package.json
└── target/                # Intermediate Rust build artifacts
```

## License

ISC - see `LICENSE.txt` file for details.
