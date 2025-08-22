# WSBroker

Node-API addon for writing high-performance multi-threaded WebSocket servers.

How does this work?

- WebSocket connections are accepted and managed by WSBroker's multi-threaded Rust code.
- Incoming WebSocket messages (and other events) are handed off to JavaScript callback methods, allowing you to write application logic.
- Your application logic can call WSBroker functions for:
  - Sending messages to specific WebSocket connections.
  - Subscribing connections to named channels.
  - Broadcasting messages to these named channels.
  - Attaching a token (meta information) to a connection.
- JavaScript callbacks are load-balanced across multiple JavaScript worker threads.

So what WSBroker buys you compared to the standard Node.js WebSocket library (`ws`):
- More performant and memory efficient connection handling.
- Multi-threading, while still allowing you to efficiently send/broadcast to any WebSocket connection.
- A ready-made channel system for broadcasting messages to multiple subscribers.

## Quick Start

### Installation

```sh
npm install wsbroker
```

### Basic Usage

```typescript
import { start, sendToChannel, subscribe } from 'wsbroker';

// Start the server and point to your worker module
start({ bind: '0.0.0.0:3000', workerPath: './my-worker.js' });

// Or specify a thread count (defaults to CPU cores, with a minimum of 4)
start({ bind: '0.0.0.0:3000', workerPath: './my-worker.js', threads: 8 });
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

## API Reference

WSBroker provides a comprehensive TypeScript API for building real-time applications. The core functions allow you to start the server, send messages, handle channels, and manage authentication. All functions are fully typed and include detailed JSDoc documentation.

The following is auto-generated from `src/index.cts`:

### start · function

Starts a WebSocket broker server bound to the given address and (optionally)
spawns worker threads that receive and handle WebSocket events.

Notes:
- Multiple servers can be started concurrently on different addresses.
  Servers share global broker state (channels, tokens, subscriptions, etc.)
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

Handles new WebSocket connections and can reject them, by returning `false` or throwing an Error.
If not provided, all connections are accepted.

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

Manually registers a worker thread with the broker to handle WebSocket messages.
This function is normally not needed, as worker threads can be automatically registered by calling `start` with a `workerPath`.

**Signature:** `(worker: WorkerInterface) => void`

**Parameters:**

- `worker` - - Worker interface implementation with optional handlers

### send · function

Sends data to a specific WebSocket connection.

**Signature:** `(socketId: number, data: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => void`

**Parameters:**

- `socketId` - - The unique identifier of the WebSocket connection
- `data` - - The data to send (Buffer, ArrayBuffer, or string)

### sendToChannel · function

Broadcasts data to all subscribers of a specific channel.

**Signature:** `(channelName: string | ArrayBuffer | Uint8Array<ArrayBufferLike>, data: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => void`

**Parameters:**

- `channelName` - - The name of the channel to broadcast to (Buffer, ArrayBuffer, or string)
- `data` - - The data to broadcast (Buffer, ArrayBuffer, or string)

### subscribe · function

Subscribes a WebSocket connection to a channel.

**Signature:** `(socketId: number, channelName: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => boolean`

**Parameters:**

- `socketId` - - The unique identifier of the WebSocket connection
- `channelName` - - The name of the channel to subscribe to (Buffer, ArrayBuffer, or string)

**Returns:** true if the subscription was added, false if already subscribed

### unsubscribe · function

Unsubscribes a WebSocket connection from a channel.

**Signature:** `(socketId: number, channelName: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => boolean`

**Parameters:**

- `socketId` - - The unique identifier of the WebSocket connection
- `channelName` - - The name of the channel to unsubscribe from (Buffer, ArrayBuffer, or string)

**Returns:** true if the subscription was removed, false if not subscribed

### setToken · function

Associates an (authentication) token with a WebSocket connection. It will be passed along with all subsequent events for that connection.

**Signature:** `(socketId: number, token: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => void`

**Parameters:**

- `socketId` - - The unique identifier of the WebSocket connection
- `token` - - The authentication token (Buffer, ArrayBuffer, or string)

### copySubscriptions · function

Copies all subscribers from one channel to another channel.

**Signature:** `(fromChannelName: string | ArrayBuffer | Uint8Array<ArrayBufferLike>, toChannelName: string | ArrayBuffer | Uint8Array<ArrayBufferLike>) => void`

**Parameters:**

- `fromChannelName` - - The source channel name (Buffer, ArrayBuffer, or string)
- `toChannelName` - - The destination channel name (Buffer, ArrayBuffer, or string)

## Examples

### Chat Server

```typescript
import { start, sendToChannel, subscribe, unsubscribe } from 'wsbroker';

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
import { start, send, setToken, subscribe } from 'wsbroker';
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

### Available Scripts

#### `npm run build`

Builds the Node addon (`index.node`) from source, generating a release build with `cargo --release`.

Additional [`cargo build`](https://doc.rust-lang.org/cargo/commands/cargo-build.html) arguments may be passed to `npm run build` and similar commands. For example, to enable a [cargo feature](https://doc.rust-lang.org/cargo/reference/features.html):

```
npm run build -- --feature=beetle
```

#### `npm run debug`

Similar to `npm run build` but generates a debug build with `cargo`.

#### `npm run cross`

Similar to `npm run build` but uses [cross-rs](https://github.com/cross-rs/cross) to cross-compile for another platform. Use the [`CARGO_BUILD_TARGET`](https://doc.rust-lang.org/cargo/reference/config.html#buildtarget) environment variable to select the build target.

#### `npm test`

Runs the unit tests by calling `cargo test`. You can learn more about [adding tests to your Rust code](https://doc.rust-lang.org/book/ch11-01-writing-tests.html) from the [Rust book](https://doc.rust-lang.org/book/).

#### `npm run release`

Initiate a full build and publication of a new patch release of this library via GitHub Actions.

#### `npm run dryrun`

Initiate a dry run of a patch release of this library via GitHub Actions. This performs a full build but does not publish the final result.

### Development Workflow

1. **Make changes** to the Rust code in `crates/wsbroker/src/lib.rs` or TypeScript code in `src/`
2. **Build the project** with `npm run debug` for development or `npm run build` for production
3. **Test your changes** using the examples in the `example/` directory
4. **Run tests** with `npm test` to ensure everything works correctly
5. **Update reference docs** in README.md using `npm run docs` if you've changed TypeScript interfaces or JSDoc comments

### Testing the Examples

The project includes example code to help you get started:

```sh
# Build and run the example server
npm run build && node lib/example/example.ts

# Or without compilation step (if using bun or a very recent Node.js)
bun example/example.ts

# Point your browser at http://localhost:3000
```

### Debugging

For development and debugging:

1. Use `npm run debug` to build with debug symbols
2. Set the `RUST_LOG` environment variable for detailed logging:
   ```sh
   RUST_LOG=debug node your-app.js
   ```
3. Use Node.js debugging tools as normal for the JavaScript/TypeScript code

## Project Layout

The directory structure of this project is:

```
wsbroker/
├── Cargo.toml
├── README.md
├── lib/                   # Generated TypeScript output
├── src/                   # TypeScript source files
|   ├── index.cts          # CommonJS entry point (includes Worker spawning logic)
|   ├── index.mts          # ESM entry point (just loads the CJS entry point)
|   └── load.cts           # Loader for platform-specific binaries
├── crates/                # Rust source code
|   └── wsbroker/
|       └── src/
|           └── lib.rs     # Main Rust implementation
├── example/               # Example applications
|   ├── example.ts         # Server example (sets up WSBroker and static HTTP)
|   ├── worker.ts          # Event-handling logic for the example, ran in worker threads
|   └── client/            # Client-side code for the example
├── platforms/             # Platform-specific binaries
├── package.json
└── target/                # Rust build artifacts
```

## Requirements

- **Node.js**: Version 18 or higher (or Bun)
- **Rust**: Tested on version 1.89 (for building from source)
- **Platform Support**: Windows, macOS (Intel/ARM), Linux (x64/ARM64)

## License

ISC - see `LICENSE.txt` file for details.
