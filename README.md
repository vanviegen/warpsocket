# WSBroker

Node-API addon for writing high-performance multi-threaded WebSocket servers.

How does this work?

- WebSocket connections are accepted and managed by WSBroker's multi-threaded Rust code.
- Incoming WebSocket messages (and other events) are handed off to JavaScript callback methods, allowing you to write application logic.
- Your application logic can call WBroker functions for:
  - Sending messages to specific WebSocket connections.
  - Subscribing connections to named channels.
  - Attaching a token (meta information) to a connection.
  - Broadcasting to these named channels.
- JavaScript callbacks can be load-balanced across multiple worker threads.

So what WSBroker buys you compared to the standard Node.js WebSocket library (`ws`):
- More performant and memory efficient connection handling.
- Multi-threading, while still allowing you to efficiently send/broadcast to any WebSocket connection.

## Quick Start

### Installation

```sh
npm install wsbroker
```

### Basic Usage

```typescript
import { registerWorkerThread, start, sendToChannel, subscribe } from 'wsbroker';

// Create a worker to handle connections
const worker = {
  handleOpen(socketId, ip, headers) {
    console.log(`New connection ${socketId} from ${ip}`);
    
    // Example: reject connections from a specific origin
    if (headers.origin === 'https://blocked-site.com') {
      console.log('Blocked connection from unauthorized origin');
      return false; // Reject the connection
    }
    
    // Log user agent if present
    if (headers['user-agent']) {
      console.log(`User-Agent: ${headers['user-agent']}`);
    }
    
    return true; // Accept the connection
  },

  handleMessage(data, socketId, token) {
    const message = Buffer.from(data).toString();
    console.log(`Message from ${socketId}: ${message}`);
    
    // Subscribe to a channel
    subscribe(socketId, 'general');
    
    // Broadcast to all subscribers
    sendToChannel('general', `User ${socketId} says: ${message}`);
  },

  handleClose(socketId, token) {
    console.log(`Connection ${socketId} closed`);
  }
};

// Register the worker and start the server
registerWorkerThread(worker);
start({ bind: '0.0.0.0:3000' });
```

### Building WSBroker

Building WSBroker requires a [supported version of Node and Rust](https://github.com/neon-bindings/neon#platform-support).

To build from source:

```sh
npm install
npm run build
```

## API Reference

WSBroker provides a comprehensive TypeScript API for building real-time applications. The core functions allow you to start the server, manage worker threads, send messages, handle channels, and manage authentication. All functions are fully typed and include detailed JSDoc documentation.

The following is auto-generated from `src/index.cts`:

### WorkerInterface · interface

Interface that worker threads must implement to handle WebSocket events.
All handler methods are optional - if not provided, the respective functionality will be unavailable.

#### workerInterface.handleMessage · member

Handles incoming WebSocket messages from clients.

**Type:** `(data: string | Uint8Array<ArrayBufferLike>, socketId: number, token?: Uint8Array<ArrayBufferLike>) => void`

#### workerInterface.handleClose · member

Handles WebSocket connection closures.

**Type:** `(socketId: number, token?: Uint8Array<ArrayBufferLike>) => void`

### start · function

Starts the WebSocket broker server on the specified bind address.

**Signature:** `(options: { bind: string; }) => void`

**Parameters:**

- `options` - - Configuration object containing the bind address

### registerWorkerThread · function

Registers a worker thread with the broker to handle WebSocket messages.
At least one worker must be registered before starting the server.

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

Associates an authentication token with a WebSocket connection.

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
import { registerWorkerThread, start, sendToChannel, subscribe, unsubscribe } from 'wsbroker';

const chatWorker = {
  handleOpen(socketId, ip, headers) {
    console.log(`New chat connection ${socketId} from ${ip}`);
    
    // Example: Block connections from specific user agents
    if (headers['user-agent'] && headers['user-agent'].includes('BadBot')) {
      console.log('Blocked bot connection');
      return false;
    }
    
    // Log origin for debugging
    if (headers.origin) {
      console.log(`Connection origin: ${headers.origin}`);
    }
    
    return true; // Accept the connection
  },

  handleMessage(data, socketId) {
    const message = JSON.parse(data.toString());
    
    switch (message.type) {
      case 'join':
        subscribe(socketId, message.room);
        sendToChannel(message.room, JSON.stringify({
          type: 'user-joined',
          userId: socketId,
          room: message.room
        }));
        break;
        
      case 'leave':
        unsubscribe(socketId, message.room);
        sendToChannel(message.room, JSON.stringify({
          type: 'user-left',
          userId: socketId,
          room: message.room
        }));
        break;
        
      case 'message':
        sendToChannel(message.room, JSON.stringify({
          type: 'chat-message',
          userId: socketId,
          text: message.text,
          timestamp: Date.now()
        }));
        break;
    }
  },
  
  handleClose(socketId) {
    // Auto-cleanup: WSBroker automatically removes closed connections from channels
    console.log(`User ${socketId} disconnected`);
  }
};

registerWorkerThread(chatWorker);
start({ bind: '0.0.0.0:3000' });
```

### WebSocket Authentication Example

```typescript
import { registerWorkerThread, start, send, setToken, subscribe } from 'wsbroker';
import jwt from 'jsonwebtoken';

const apiWorker = {
  handleOpen(socketId, ip, headers) {
    console.log(`API connection ${socketId} from ${ip}`);
    
    // Example: Only allow connections from specific origins
    const allowedOrigins = ['https://myapp.com', 'https://admin.myapp.com'];
    if (headers.origin && !allowedOrigins.includes(headers.origin)) {
      console.log(`Rejected connection from unauthorized origin: ${headers.origin}`);
      return false;
    }
    
    return true;
  },

  handleMessage(data, socketId, currentToken) {
    const message = JSON.parse(data.toString());
    
    if (message.type === 'authenticate') {
      try {
        const decoded = jwt.verify(message.token, 'secret');
        setToken(socketId, message.token);
        
        // Subscribe to user-specific channel
        subscribe(socketId, `user:${decoded.userId}`);
        
        send(socketId, JSON.stringify({ type: 'authenticated', userId: decoded.userId }));
      } catch (error) {
        send(socketId, JSON.stringify({ type: 'auth-error', message: 'Invalid token' }));
      }
    } else if (currentToken) {
      // Handle authenticated user messages
      const decoded = jwt.verify(currentToken.toString(), 'secret');
      // Process message from authenticated user...
    } else {
      send(socketId, JSON.stringify({ type: 'error', message: 'Authentication required' }));
    }
  }
};

registerWorkerThread(apiWorker);
start({ bind: '0.0.0.0:3000' });
```

## How It Works

WSBroker uses a multi-layered architecture:

1. **Rust Core**: The core broker logic is implemented in Rust for maximum performance, handling WebSocket connections, channel management, and message routing.

2. **Worker Threads**: JavaScript worker threads handle application logic, allowing you to write business logic in familiar Node.js while benefiting from Rust's performance for the networking layer.

3. **Channel System**: Connections can subscribe to named channels (string or binary). Messages sent to a channel are automatically broadcasted to all subscribers.

4. **Connection Management**: Each WebSocket connection gets a unique ID and can be associated with authentication tokens for secure operations.

### Performance Characteristics

- **Message Routing**: Sub-millisecond routing between connected clients
- **Memory Usage**: Minimal overhead per connection (~1KB per WebSocket)
- **Concurrent Connections**: Scales to thousands of simultaneous connections
- **Channel Efficiency**: O(1) channel subscription/unsubscription operations
- **Worker Load Balancing**: Automatic distribution of connections across worker threads

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

1. **Make changes** to the Rust code in `crates/ws-broker/src/lib.rs` or TypeScript code in `src/`
2. **Build the project** with `npm run debug` for development or `npm run build` for production
3. **Update documentation** with `npm run docs` if you've changed TypeScript interfaces or JSDoc comments
4. **Test your changes** using the examples in the `example/` directory
5. **Run tests** with `npm test` to ensure everything works correctly

### Updating Documentation

The API Reference section is automatically generated from TypeScript source files using JSDoc comments. To update the documentation:

```sh
npm run docs
```

This will scan the TypeScript files and update the README.md with the latest API documentation. The documentation is automatically updated before publishing via the `prepublishOnly` script.

### Testing the Examples

The project includes example code to help you get started:

```sh
# Build the project
npm run build

# Run the example server
node example/example.ts

# In another terminal, test the WebSocket connection
node example/test-client.js
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
├── lib/                    # Generated TypeScript output
├── src/                    # TypeScript source files
|   ├── index.mts          # ESM entry point
|   ├── index.cts          # CommonJS entry point
|   └── load.cts           # Platform-specific loader
├── crates/                # Rust source code
|   └── ws-broker/
|       └── src/
|           └── lib.rs     # Main Rust implementation
├── example/               # Example applications
|   ├── example.ts         # Server example
|   └── test-client.js     # WebSocket client test
├── platforms/             # Platform-specific binaries
├── package.json
└── target/               # Rust build artifacts
```

| Entry          | Purpose                                                                                                                                  |
|----------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `Cargo.toml`   | The Cargo [manifest file](https://doc.rust-lang.org/cargo/reference/manifest.html), which informs the `cargo` command.                   |
| `README.md`    | This file.                                                                                                                               |
| `lib/`         | The directory containing the generated output from [tsc](https://typescriptlang.org).                                                    |
| `src/`         | The directory containing the TypeScript source files.                                                                                    |
| `index.mts`    | Entry point for when this library is loaded via [ESM `import`](https://nodejs.org/api/esm.html#modules-ecmascript-modules) syntax.       |
| `index.cts`    | Entry point for when this library is loaded via [CJS `require`](https://nodejs.org/api/modules.html#requireid).                          |
| `load.cts`     | Platform-specific binary loader using [@neon-rs/load](https://www.npmjs.com/package/@neon-rs/load).                                      |
| `crates/`      | The directory tree containing the Rust source code for the project.                                                                      |
| `lib.rs`       | Entry point for the Rust source code - contains the core broker implementation.                                                          |
| `example/`     | Example applications demonstrating WSBroker usage.                                                                                       |
| `platforms/`   | The directory containing distributions of the binary addon backend for each platform supported by this library.                          |
| `package.json` | The npm [manifest file](https://docs.npmjs.com/cli/v7/configuring-npm/package-json), which informs the `npm` command.                    |
| `target/`      | Binary artifacts generated by the Rust build.                                                                                            |

## Requirements

- **Node.js**: Version 18 or higher
- **Rust**: Latest stable version (for building from source)
- **Platform Support**: Windows, macOS (Intel/ARM), Linux (x64/ARM64)

## License

MIT

## Learn More

Learn more about the technologies used in WSBroker:

- [Neon](https://neon-bindings.com) - Rust bindings for writing safe and fast native Node.js modules
- [Rust](https://www.rust-lang.org) - Systems programming language focused on safety and performance
- [Node.js](https://nodejs.org) - JavaScript runtime built on Chrome's V8 JavaScript engine
- [WebSockets](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) - Protocol for full-duplex communication over TCP
- [Tokio](https://tokio.rs) - Asynchronous runtime for Rust
