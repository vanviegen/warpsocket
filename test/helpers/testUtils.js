const test = require('node:test');
const WebSocket = require('ws');
const { spawnServer } = require('./spawnServer.js');

// Global server instance
let currentServer = null;

/**
 * Create a new WebSocket connection to the current test server.
 * The WebSocket will be automatically connected before returning.
 * @param {string} [url] - Optional URL to connect to. If not provided, uses the current test server.
 * @returns {Promise<WebSocket>} A connected WebSocket instance
 */
async function createWebSocket(url) {
  if (!url) {
    if (!currentServer) {
      throw new Error('No server available. This should only be called within a test.');
    }
    url = currentServer.url;
  }
  
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => { 
    ws.once('open', resolve); 
    ws.once('error', reject); 
  });

  const state = {
    queue: []
  };

  states.set(ws, state);

  ws.on('message', (data) => {
    if (state.cb) {
      state.cb[0](data);
      delete state.cb;
    } else {
      state.queue.push(data);
    }
  });

  ws.on('close', (code,reason) => {
    reason = reason instanceof Buffer ? new TextDecoder().decode(reason) : reason;
    const state = states.get(ws);
    if (state.cb) {
      delete state.queue;
      state.cb[1](new Error(`WebSocket closed (code:${code}, reason: ${reason})`));
      delete state.cb;
    }
  });

  ws.on('error', (err) => {
    const state = states.get(ws);
    if (state.cb) {
      delete state.queue;
      state.cb[1](err);
      delete state.cb;
    }
  });

  return ws;
}

const states = new WeakMap();

/**
 * Spawn a server with custom options for a specific test.
 * This will replace the default server for the current test.
 * @param {object} opts - Server spawn options
 * @returns {Promise<string>} The WebSocket URL for the spawned server
 */
async function spawnCustomServer(opts = {}) {
  // Kill existing server if any
  if (currentServer) {
    currentServer.kill();
  }
  
  currentServer = await spawnServer(opts);
  return currentServer.url;
}

// Set up global test hooks for server lifecycle management
test.beforeEach(async () => {
  // Spawn a default server for each test
  currentServer = await spawnServer();
});

test.afterEach(async () => {
  // Always clean up the server after each test
  if (currentServer) {
    currentServer.kill();
    currentServer = null;
  }
});

// Helper functions for WebSocket testing

/**
 * Wait for the next raw (text or binary) message from a WebSocket.
 * @param {WebSocket} ws - The WebSocket instance
 * @param {number} timeout - Timeout in milliseconds (default: 2000)
 * @returns {Promise<string|Buffer>} The raw message as a string or binary data
 */
const onceMessageRaw = (ws, timeout = 2000) => new Promise((resolve, reject) => {
  const state = states.get(ws);
  if (state.cb) reject(new Error('Already waiting for a message on this WebSocket'));
  if (!state.queue) reject(new Error('WebSocket has been closed'));
  if (state.queue.length) resolve(state.queue.shift());
  else {
    state.cb = [resolve, reject];
    setTimeout(() => {
      if (state.cb && state.cb[0] === resolve) {
        delete state.cb;
        reject(new Error('Timeout waiting for message'));
      }
    }, timeout);
  }
});

/**
 * Like above, but JSON.
 * @param {WebSocket} ws - The WebSocket instance
 * @param {number} timeout - Timeout in milliseconds (default: 2000)
 * @returns The message data, decoded as JSON.
 */
const onceMessage = async (ws, timeout = 2000) => {
  return JSON.parse(await onceMessageRaw(ws, timeout));
};

/**
 * Wait for a message of a specific type from a WebSocket
 * @param {WebSocket} ws - The WebSocket instance
 * @param {string} type - The message type to wait for (optional)
 * @param {number} timeout - Timeout in milliseconds (default: 2000)
 * @returns {Promise<object>} The parsed message object
 */
const onceMessageOfType = async (ws, type, timeout = 2000) => {
  while(true) {
    const msg = await onceMessage(ws, timeout);
    if (!type || msg.type === type) return msg;
  }
};

module.exports = {
  createWebSocket,
  spawnCustomServer,
  onceMessage,
  onceMessageRaw,
  onceMessageOfType
};
