# WSBroker

A high-performance WebSocket broker built with Rust and Node.js using Neon bindings. WSBroker provides a scalable real-time messaging infrastructure with channel-based pub/sub functionality, HTTP request handling, and multi-worker thread support.

## What is WSBroker?

WSBroker is a WebSocket server that acts as a message broker between clients, enabling real-time communication patterns like:

- **Pub/Sub messaging**: Clients can subscribe to channels and receive messages published to those channels
- **Direct messaging**: Send messages directly to specific WebSocket connections
- **HTTP handling**: Process HTTP requests alongside WebSocket connections
- **Authentication**: Token-based authentication for WebSocket connections
- **Load balancing**: Multi-worker thread architecture for handling concurrent connections

## Why Use WSBroker?

- **High Performance**: Built in Rust for maximum speed and minimal memory overhead
- **Scalable**: Multi-worker architecture distributes load across threads
- **Flexible**: Supports both HTTP and WebSocket protocols in a single server
- **Type Safe**: Full TypeScript support with comprehensive type definitions
- **Real-time**: Sub-millisecond message routing between connected clients
- **Cross-platform**: Supports Windows, macOS, and Linux through native binaries

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
  handleHttpRequest(request) {
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello from WSBroker!' })
    };
  },

  handleSocketMessage(data, socketId, token) {
    const message = Buffer.from(data).toString();
    console.log(`Message from ${socketId}: ${message}`);
    
    // Subscribe to a channel
    subscribe(socketId, 'general');
    
    // Broadcast to all subscribers
    sendToChannel('general', `User ${socketId} says: ${message}`);
  },

  handleSocketClose(socketId, token) {
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

Interface that worker threads must implement to handle HTTP requests and WebSocket events.
All handler methods are optional - if not provided, the respective functionality will be unavailable.

#### workerInterface.handleHttpRequest · member

Handles incoming HTTP requests.

**Type:** `(request: HttpRequest) => void | HttpResponse`

#### workerInterface.handleSocketMessage · member

Handles incoming WebSocket messages from clients.

**Type:** `(data: string | Uint8Array<ArrayBufferLike>, socketId: number, token?: Uint8Array<ArrayBufferLike>) => void`

#### workerInterface.handleSocketClose · member

Handles WebSocket connection closures.

**Type:** `(socketId: number, token?: Uint8Array<ArrayBufferLike>) => void`

### HttpRequest · interface

HTTP request object with Node.js-compatible properties

#### httpRequest.method · member

HTTP method (GET, POST, etc.)

**Type:** `string`

#### httpRequest.url · member

Full URL path including query string

**Type:** `string`

#### httpRequest.path · member

Request path without query parameters

**Type:** `string`

#### httpRequest.pathname · member

Request path without query parameters (alias for path)

**Type:** `string`

#### httpRequest.search · member

Query string with leading '?' (if present)

**Type:** `string`

#### httpRequest.query · member

Query string parameters (raw string)

**Type:** `string`

#### httpRequest.headers · member

HTTP headers as key-value pairs (case-insensitive access)

**Type:** `Record<string, string>`

#### httpRequest.body · member

Request body as binary data

**Type:** `Uint8Array<ArrayBufferLike>`

### HttpResponse · interface

HTTP response object that handlers should populate

#### httpResponse.status · member

HTTP status code

**Type:** `number`

#### httpResponse.headers · member

Response headers as key-value pairs

**Type:** `Record<string, string>`

#### httpResponse.body · member

Response body (string, Buffer, ArrayBuffer, or Uint8Array)

**Type:** `string | ArrayBuffer | Uint8Array<ArrayBufferLike>`

### start · function

Starts the WebSocket broker server on the specified bind address.

**Signature:** `(options: { bind: string; }) => void`

**Parameters:**

- `options` - - Configuration object containing the bind address

### registerWorkerThread · function

Registers a worker thread with the broker to handle HTTP requests and WebSocket messages.
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
  handleSocketMessage(data, socketId) {
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
  
  handleSocketClose(socketId) {
    // Auto-cleanup: WSBroker automatically removes closed connections from channels
    console.log(`User ${socketId} disconnected`);
  }
};

registerWorkerThread(chatWorker);
start({ bind: '0.0.0.0:3000' });
```

### Real-time API with Authentication

```typescript
import { registerWorkerThread, start, send, setToken, subscribe } from 'wsbroker';
import jwt from 'jsonwebtoken';

const apiWorker = {
  handleHttpRequest(request) {
    if (request.path === '/auth' && request.method === 'POST') {
      const body = JSON.parse(request.body.toString());
      const token = jwt.sign({ userId: body.userId }, 'secret');
      
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token })
      };
    }
    
    return { status: 404, headers: {}, body: 'Not Found' };
  },
  
  handleSocketMessage(data, socketId, currentToken) {
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

5. **Hybrid Protocol**: The same server handles both HTTP requests and WebSocket upgrades, allowing you to serve APIs and real-time features from one process.

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
