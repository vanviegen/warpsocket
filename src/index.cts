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
 * Interface that worker threads must implement to handle HTTP requests and WebSocket events.
 * All handler methods are optional - if not provided, the respective functionality will be unavailable.
 */
export interface WorkerInterface {
  /**
   * Handles incoming HTTP requests.
   * @param request - The HTTP request details
   * @returns The HTTP response object, or void for default 200 OK response
   */
  handleHttpRequest?(request: HttpRequest): HttpResponse | void;
  
  /**
   * Handles incoming WebSocket messages from clients.
   * @param data - The message data (Buffer for binary, string for text)
   * @param socketId - The unique identifier of the WebSocket connection
   * @param token - The authentication token associated with the connection (if any)
   */
  handleSocketMessage?(data: Uint8Array | string, socketId: number, token?: Uint8Array): void;
  
  /**
   * Handles WebSocket connection closures.
   * @param socketId - The unique identifier of the closed WebSocket connection
   * @param token - The authentication token associated with the connection (if any)
   */
  handleSocketClose?(socketId: number, token?: Uint8Array): void;
}

/** HTTP request object with Node.js-compatible properties */
export interface HttpRequest {
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** Full URL path including query string */
  url: string;
  /** Request path without query parameters */
  path: string;
  /** Request path without query parameters (alias for path) */
  pathname: string;
  /** Query string with leading '?' (if present) */
  search?: string;
  /** Query string parameters (raw string) */
  query?: string;
  /** HTTP headers as key-value pairs (case-insensitive access) */
  headers: Record<string, string>;
  /** Request body as binary data */
  body: Uint8Array;
}

/** HTTP response object that handlers should populate */
export interface HttpResponse {
  /** HTTP status code */
  status: number;
  /** Response headers as key-value pairs */
  headers: Record<string, string>;
  /** Response body (string, Buffer, ArrayBuffer, or Uint8Array) */
  body: string | Uint8Array | ArrayBuffer;
}

// Export the native addon functions with proper TypeScript bindings

/** 
 * Starts the WebSocket broker server on the specified bind address.
 * @param options - Configuration object containing the bind address
 */
export const start = addon.start;

/** 
 * Registers a worker thread with the broker to handle HTTP requests and WebSocket messages.
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
