// This module is the CJS entry point for the library.

import * as addon from 'warpsocket/addon-loader';
import { Worker } from 'node:worker_threads';
import * as os from 'node:os';
import * as pathMod from 'node:path';

declare module "warpsocket/addon-loader" {
    function start(bind: string): void;
    function registerWorkerThread(worker: WorkerInterface): void;
    function send(target: number | Uint8Array | ArrayBuffer | string, data: Uint8Array | ArrayBuffer | string): boolean;
    function subscribe(socketId: number, channelName: Uint8Array | ArrayBuffer | string): boolean;
    function unsubscribe(socketId: number, channelName: Uint8Array | ArrayBuffer | string): boolean;
    function setToken(socketId: number, token: Uint8Array | ArrayBuffer | string): void;
    function copySubscriptions(fromChannelName: Uint8Array | ArrayBuffer | string, toChannelName: Uint8Array | ArrayBuffer | string): void;
    function hasSubscriptions(channelName: Uint8Array | ArrayBuffer | string): boolean;
    function createVirtualSocket(socketId: number, userData?: number): number;
    function deleteVirtualSocket(virtualSocketId: number, expectedTargetSocketId?: number): boolean;
}

/**
* Interface that worker threads must implement to handle WebSocket events.
* All handler methods are optional - if not provided, the respective functionality will be unavailable.
*/
export interface WorkerInterface {
    /**
    * Handles new WebSocket connections and can reject them. If not provided, all connections are accepted.
    * @param socketId - The unique identifier of the WebSocket connection.
    * @param ip - The client's IP address.
    * @param headers - HTTP headers from the WebSocket handshake request.
    * @returns true to accept the connection, false to reject it.
    */
    handleOpen?(socketId: number, ip: string, headers: Record<string, string>): boolean;
    
    /**
    * Handles incoming WebSocket text messages from clients.
    * @param data - The message data as a string.
    * @param socketId - The unique identifier of the WebSocket connection.
    * @param token - The authentication token associated with the connection (if any).
    */
    handleTextMessage?(data: string, socketId: number, token?: Uint8Array): void;

    /**
    * Handles incoming WebSocket binary messages from clients.
    * @param data - The message data as a Uint8Array.
    * @param socketId - The unique identifier of the WebSocket connection.
    * @param token - The authentication token associated with the connection (if any).
    */
    handleBinaryMessage?(data: Uint8Array, socketId: number, token?: Uint8Array): void;

    /**
    * Handles WebSocket connection closures.
    * @param socketId - The unique identifier of the closed WebSocket connection.
    * @param token - The authentication token associated with the connection (if any).
    */
    handleClose?(socketId: number, token?: Uint8Array): void;
}

// Internal array to keep Worker instances alive
const workers: Worker[] = [];

/** 
 * Starts a WebSocket server bound to the given address and (optionally)
 * spawns worker threads that receive and handle WebSocket events.
 *
 * Notes:
 * - Multiple servers can be started concurrently on different addresses.
 *   Servers share global server state (channels, tokens, subscriptions, etc.)
 *   and the same worker pool.
 * - Calling `start` without `workerPath` requires that at least one worker
 *   has been registered previously via `registerWorkerThread`.
 *
 * @param options - Configuration object:
 *   - bind: Required. Address string to bind the server to (e.g. "127.0.0.1:8080").
 *   - workerPath: Optional. Path (absolute or relative to process.cwd()) to the
 *                 worker JavaScript module to load in threads. If provided,
 *                 the module will be imported in each worker thread and any
 *                 exported handlers will be registered with the native addon.
 *                 Worker modules may export any subset of the `WorkerInterface`
 *                 handlers. If `threads` is 0, the module will be registered
 *                 on the main thread and no worker threads will be spawned.
 *   - threads: Optional. Number of worker threads to spawn. When 0 the
 *              worker module is registered on the main thread. When a positive
 *              integer is provided, that number of Node.js `Worker` threads
 *              are created and set up to handle WebSocket events. When omitted,
 *              defaults to the number of CPU cores or 4, whichever is higher.
 *
 * @returns A Promise that resolves after worker threads (if any) have been
 *          started and the native addon has been instructed to bind to the
 *          address. The Promise rejects if worker initialization fails.
 *
 * @throws If `options` is missing or `options.bind` is not a string.
 */
export async function start(options: { bind: string, workerPath?: string, threads?: number }): Promise<void> {
    if (!options || typeof options.bind !== 'string') {
        throw new Error('options.bind (string) is required');
    }
    if (options.workerPath) {
        await spawnWorkers(options.workerPath, options.threads);
    }

    addon.start(options.bind);
}

const BOOTSTRAP_WORKER = `
const { workerData: workerModulePath, parentPort } = require('node:worker_threads');
const addon = require('warpsocket/addon-loader');
(async () => {
    const workerModule = await import(workerModulePath);
    addon.registerWorkerThread(workerModule);
    parentPort.postMessage({ type: 'registered' });
})().catch((err) => {
    console.error('warpsocket: worker init failed:', err);
});
`;

function spawnWorker(workerModulePath: string, running=false): Promise<void> { 
    return new Promise<void>((resolve, reject) => {
        const w = new Worker(BOOTSTRAP_WORKER, {
            
            eval: true,
            workerData: workerModulePath
        });

        w.on('message', (msg) => {
            if (msg && (msg as any).type === 'registered') {
                running = true;
                resolve();
            }
        });

        w.on('error', (err) => {
            console.error('warpsocket: worker thread error:', err);
        });

        w.on('exit', (code) => {
            console.error('warpsocket: worker thread exited with code', code);
            if (running) {
                // Start a replacement worker
                spawnWorker(workerModulePath, true);
            } else {
                reject(new Error(`Could not start worker`));
            }
        });

    });
}

async function spawnWorkers(workerModulePath: string, threads?: number): Promise<void> {
    if (!pathMod.isAbsolute(workerModulePath)) {
        workerModulePath = pathMod.resolve(process.cwd(), workerModulePath);
    }

    const threadCount = threads == null ? Math.max(os.cpus()?.length || 1, 4) : threads;

    // If threads is 0 or less, register the worker module on the main thread
    if (threadCount <= 0) {
        addon.registerWorkerThread(await import(workerModulePath));
        return;
    }

    const promises = [];
    for (let i = 0; i < threadCount; i++) {
        promises.push(spawnWorker(workerModulePath));
    }
    await Promise.all(promises);
}

/** 
* Manually registers a worker thread with the server to handle WebSocket messages.
* This function is normally not needed, as worker threads can be automatically registered by calling `start` with a `workerPath`.
* @param worker - Worker interface implementation with optional handlers.
*/
export const registerWorkerThread = addon.registerWorkerThread;

/** 
* Sends data to a specific WebSocket connection or broadcasts to all subscribers of a channel.
* @param target - The target for the message: either a socket ID (number) or channel name (Buffer, ArrayBuffer, or string).
* @param data - The data to send (Buffer, ArrayBuffer, or string).
* @returns true if the message was sent successfully, false otherwise.
* 
* When target is a channel name and the channel has virtual socket subscribers with user data:
* - For text messages: adds the user data as the `_vsud` property to JSON objects.
*   Example: `{"_vsud":12345,"your":"original","data":true}`.
* - For binary messages: prefixes the user data as a 32-bit integer in network byte order.
*/
export const send = addon.send;

/** 
* Subscribes a WebSocket connection to a channel.
* @param socketId - The unique identifier of the WebSocket connection.
* @param channelName - The name of the channel to subscribe to (Buffer, ArrayBuffer, or string).
* @returns true if the subscription was added, false if already subscribed.
*/
export const subscribe = addon.subscribe;

/** 
* Unsubscribes a WebSocket connection from a channel.
* @param socketId - The unique identifier of the WebSocket connection.
* @param channelName - The name of the channel to unsubscribe from (Buffer, ArrayBuffer, or string).
* @returns true if the subscription was removed, false if not subscribed.
*/
export const unsubscribe = addon.unsubscribe;

/** 
* Associates an authentication token with a WebSocket connection. It will be passed along with all subsequent events for that connection.
* @param socketId - The unique identifier of the WebSocket connection.
* @param token - The authentication token (Buffer, ArrayBuffer, or string). It will be converted to a (UTF-8 encoded) Uint8Array.
*/
export const setToken = addon.setToken;

/** 
* Copies all subscribers from one channel to another channel.
* @param fromChannelName - The source channel name (Buffer, ArrayBuffer, or string).
* @param toChannelName - The destination channel name (Buffer, ArrayBuffer, or string).
*/
export const copySubscriptions = addon.copySubscriptions;

/**
 * Checks if a channel has any subscribers.
 * @param channelName - The name of the channel to check (Buffer, ArrayBuffer, or string).
 * @returns True if the channel has subscribers, false otherwise.
 */
export const hasSubscriptions = addon.hasSubscriptions;

/**
 * Creates a virtual socket that points to an actual WebSocket connection.
 * Virtual sockets can be subscribed to channels, and messages will be relayed to the underlying actual socket.
 * This allows for convenient bulk unsubscription by deleting the virtual socket.
 * Virtual sockets can also point to other virtual sockets, creating a chain that resolves to an actual socket.
 * @param socketId - The identifier of the actual WebSocket connection or another virtual socket to point to.
 * @param userData - Optional user data (32-bit signed integer) that will be included in channel broadcasts to this virtual socket.
 *     When provided, this data will be included in messages sent to channels this virtual socket subscribes to.
 *     - Text messages will need to be JSON objects for this to work. They'll get a `_vsud` property added with the user data.
 *     - Binary messages will be prefixed with a i32 in network order.
 * @returns The unique identifier of the newly created virtual socket, which can be used just like another socket.
 */
export const createVirtualSocket = addon.createVirtualSocket;

/**
 * Deletes a virtual socket and unsubscribes it from all channels.
 * This is a convenient way to bulk-unsubscribe a virtual socket from all its channels at once.
 * @param virtualSocketId - The unique identifier of the virtual socket to delete.
 * @param expectedTargetSocketId - Optional. If provided, the virtual socket will only be deleted 
 *   if it points to this specific target socket ID. This can help prevent unauthorized unsubscribes.
 * @returns true if the virtual socket was deleted, false if it was not found or target didn't match.
 */
export const deleteVirtualSocket = addon.deleteVirtualSocket;
