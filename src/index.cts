// This module is the CJS entry point for the library.

// The Rust addon.
import * as addon from './load.cjs';

// Use this declaration to assign types to the addon's exports,
// which otherwise by default are `any`.
declare module "./load.cjs" {
  function start(options: { bind: string }): void;
  function registerWorkerThread(worker: WorkerInterface): void;
  function send(socketId: number, data: Uint8Array | ArrayBuffer | string): void;
  function sendToChannel(channelName: Uint8Array | ArrayBuffer | string, data: Uint8Array | ArrayBuffer | string): void;
  function subscribe(socketId: number, channelName: Uint8Array | ArrayBuffer | string): boolean;
  function unsubscribe(socketId: number, channelName: Uint8Array | ArrayBuffer | string): boolean;
  function setToken(socketId: number, token: Uint8Array | ArrayBuffer | string): void;
  function copySubscriptions(fromChannelName: Uint8Array | ArrayBuffer | string, toChannelName: Uint8Array | ArrayBuffer | string): void;
}

/**
 * Interface that worker threads must implement to handle WebSocket events.
 * All handler methods are optional - if not provided, the respective functionality will be unavailable.
 */
export interface WorkerInterface {
  /**
   * Handles new WebSocket connections and can reject them. If not provided, all connections are accepted.
   * @param socketId - The unique identifier of the WebSocket connection
   * @param ip - The client's IP address
   * @param headers - HTTP headers from the WebSocket handshake request
   * @returns true to accept the connection, false to reject it
   */
  handleOpen?(socketId: number, ip: string, headers: Record<string, string>): boolean;

  /**
   * Handles incoming WebSocket messages from clients.
   * @param data - The message data (Buffer for binary, string for text)
   * @param socketId - The unique identifier of the WebSocket connection
   * @param token - The authentication token associated with the connection (if any)
   */
  handleMessage?(data: Uint8Array | string, socketId: number, token?: Uint8Array): void;
  
  /**
   * Handles WebSocket connection closures.
   * @param socketId - The unique identifier of the closed WebSocket connection
   * @param token - The authentication token associated with the connection (if any)
   */
  handleClose?(socketId: number, token?: Uint8Array): void;
}

// Export the native addon functions with proper TypeScript bindings

/** 
 * Starts a WebSocket broker server on the specified bind address.
 * Can be called multiple times to run servers on different addresses simultaneously.
 * All servers share the same worker pool and global state (channels, tokens, etc.).
 * @param options - Configuration object containing the bind address
 */
export const start = addon.start;

/** 
 * Registers a worker thread with the broker to handle WebSocket messages.
 * At least one worker must be registered before starting the server.
 * @param worker - Worker interface implementation with optional handlers
 */
export const registerWorkerThread = addon.registerWorkerThread;

/** 
 * Sends data to a specific WebSocket connection.
 * @param socketId - The unique identifier of the WebSocket connection
 * @param data - The data to send (Buffer, ArrayBuffer, or string)
 */
export const send = addon.send;

/** 
 * Broadcasts data to all subscribers of a specific channel.
 * @param channelName - The name of the channel to broadcast to (Buffer, ArrayBuffer, or string)
 * @param data - The data to broadcast (Buffer, ArrayBuffer, or string)
 */
export const sendToChannel = addon.sendToChannel;

/** 
 * Subscribes a WebSocket connection to a channel.
 * @param socketId - The unique identifier of the WebSocket connection
 * @param channelName - The name of the channel to subscribe to (Buffer, ArrayBuffer, or string)
 * @returns true if the subscription was added, false if already subscribed
 */
export const subscribe = addon.subscribe;

/** 
 * Unsubscribes a WebSocket connection from a channel.
 * @param socketId - The unique identifier of the WebSocket connection
 * @param channelName - The name of the channel to unsubscribe from (Buffer, ArrayBuffer, or string)
 * @returns true if the subscription was removed, false if not subscribed
 */
export const unsubscribe = addon.unsubscribe;

/** 
 * Associates an authentication token with a WebSocket connection.
 * @param socketId - The unique identifier of the WebSocket connection
 * @param token - The authentication token (Buffer, ArrayBuffer, or string)
 */
export const setToken = addon.setToken;

/** 
 * Copies all subscribers from one channel to another channel.
 * @param fromChannelName - The source channel name (Buffer, ArrayBuffer, or string)
 * @param toChannelName - The destination channel name (Buffer, ArrayBuffer, or string)
 */
export const copySubscriptions = addon.copySubscriptions;
