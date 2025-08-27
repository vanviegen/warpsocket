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
  await new Promise((resolve, reject) => { 
    ws.once('open', resolve); 
    ws.once('error', reject); 
  });
  
  return ws;
}

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
 * Wait for the next message from a WebSocket
 * @param {WebSocket} ws - The WebSocket instance
 * @returns {Promise<string>} The message as a string
 */
const onceMessage = (ws) => new Promise((resolve) => 
  ws.once('message', (m) => resolve(m.toString()))
);

/**
 * Wait for a message of a specific type from a WebSocket
 * @param {WebSocket} ws - The WebSocket instance
 * @param {string} type - The message type to wait for (optional)
 * @param {number} timeout - Timeout in milliseconds (default: 2000)
 * @returns {Promise<object>} The parsed message object
 */
const onceMessageOfType = (ws, type, timeout = 2000) => new Promise((resolve, reject) => {
  const onMsg = (m) => {
    const obj = JSON.parse(m.toString());
    if (!type || obj.type === type) {
      ws.off('message', onMsg);
      resolve(obj);
    }
  };
  ws.on('message', onMsg);
  if (timeout != null) {
    setTimeout(() => reject(new Error(`Timeout waiting for message type: ${type}`)), timeout);
  }
});

module.exports = {
  createWebSocket,
  spawnCustomServer,
  onceMessage,
  onceMessageOfType
};
