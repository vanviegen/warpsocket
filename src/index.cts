// This module is the CJS entry point for the library.

import * as addon from 'warpsocket/addon-loader';
import { Worker } from 'node:worker_threads';
import * as os from 'node:os';
import * as pathMod from 'node:path';

declare module "warpsocket/addon-loader" {
    function start(bind: string): void;
    function registerWorkerThread(worker: WorkerInterface): number;
    function deregisterWorkerThread(workerId: number): boolean;
    function send(target: number | number[] | Uint8Array | ArrayBuffer | string | (number | Uint8Array | ArrayBuffer | string)[], data: Uint8Array | ArrayBuffer | string): number;
    function subscribe(socketIdOrChannelName: number | number[] | Uint8Array | ArrayBuffer | string | (number | Uint8Array | ArrayBuffer | string)[], channelName: Uint8Array | ArrayBuffer | string, delta?: number): number[];
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
    */
    handleTextMessage?(data: string, socketId: number): void;

    /**
    * Handles incoming WebSocket binary messages from clients.
    * @param data - The message data as a Uint8Array.
    * @param socketId - The unique identifier of the WebSocket connection.
    */
    handleBinaryMessage?(data: Uint8Array, socketId: number): void;

    /**
    * Handles WebSocket connection closures.
    * @param socketId - The unique identifier of the closed WebSocket connection.
    */
    handleClose?(socketId: number): void;
}

// Internal map to keep Worker instances alive and allow termination
const workers = new Map<number, {worker: Worker, lastSeen: number}>();

// Worker monitoring state
const WORKER_TIMEOUT_MS = 3000; // 3 seconds timeout

/*
* Start the worker monitoring system that pings workers and terminates hanging ones.
*/
setInterval(() => {
    const now = Date.now();

    for (const [workerId, worker] of workers) {
        const timeSinceLastSeen = now - worker.lastSeen;
        if (timeSinceLastSeen > WORKER_TIMEOUT_MS) {
            addon.deregisterWorkerThread(workerId);
            worker.worker.terminate();
            workers.delete(workerId);
        }

        worker.worker.postMessage({ type: '__ping', timestamp: now });
    }
}, 500); // Check twice per second


/** 
 * Starts a WebSocket server bound to the given address and (optionally)
 * spawns worker threads that receive and handle WebSocket events.
 *
 * Notes:
 * - Multiple servers can be started concurrently on different addresses.
 *   Servers share global server state (channels, tokens, subscriptions, etc.)
 *   and the same worker pool.
 * - Calling `start` without `workerPath` will only work if `start` was already
 *   called earlier with a `workerPath`. 
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
 *   - threads: Optional. Number of worker threads to spawn. When a positive
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

// Handle ping messages from main thread
parentPort.on('message', (msg) => {
    if (msg && msg.type === '__ping') {
        parentPort.postMessage({ type: '__pong', timestamp: msg.timestamp });
    }
});

(async () => {
    const workerModule = await import(workerModulePath);
    const workerId = addon.registerWorkerThread(workerModule);
    console.log('Worker bootstrap: registered with workerId', workerId);
    parentPort.postMessage({ type: 'registered', workerId });
})();
`;

function spawnWorker(workerModulePath: string, running=false): Promise<void> { 
    return new Promise<void>((resolve, reject) => {
        const w = new Worker(BOOTSTRAP_WORKER, {
            eval: true,
            workerData: workerModulePath
        });

        let workerId: number;

        w.on('message', (msg) => {
            if (msg && (msg as any).type === 'registered') {
                workerId = (msg as any).workerId;
                workers.set(workerId, {worker: w, lastSeen: Date.now()});
                console.log(`Worker ${workerId} registered`);
                running = true;
                resolve();
            } else if (msg && (msg as any).type === '__pong') {
                workers.get(workerId)!.lastSeen = Date.now();
            }
        });

        w.on('error', (err) => {
            console.error('warpsocket: worker thread error:', err);
        });

        w.on('exit', (code) => {
            console.error('warpsocket: worker thread exited with code', code);
            workers.delete(workerId);
            addon.deregisterWorkerThread(workerId);
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

    const threadCount = threads == null ? Math.max(os.cpus()?.length || 1, 4) : Math.max(0, 0|threads);

    const promises = [];
    for (let i = 0; i < threadCount; i++) {
        promises.push(spawnWorker(workerModulePath));
    }
    await Promise.all(promises);
}

/** 
* Sends data to a specific WebSocket connection, multiple connections, or broadcasts to all subscribers of a channel.
* @param target - The target for the message: 
*   - A socket ID (number): sends to that specific socket
*   - A channel name (Buffer, ArrayBuffer, or string): broadcasts to all subscribers of that channel
*   - An array of socket IDs and/or channel names: sends to each socket and broadcasts to each channel
* @param data - The data to send (Buffer, ArrayBuffer, or string).
* @returns the number of recipients that got sent the message.
*
* When target is a virtual socket with user data (or a channel that has such a subscriber):
* - For text messages: adds the user data as the `_vsud` property to JSON objects.
*   Example: `{"_vsud":12345,"your":"original","data":true}`.
* - For binary messages: prefixes the user data as a 32-bit integer in network byte order.
* 
* When target is an array, the message is sent to each target in the array.
*/
export const send = addon.send;

/** 
* Subscribes one or more WebSocket connections to a channel, or copies subscriptions from one channel to another.
* Multiple subscriptions to the same channel by the same connection are reference-counted.
* 
* @param socketIdOrChannelName - Can be:
*   - A single socket ID (number): applies delta to that socket's subscription
*   - An array of socket IDs (number[]): applies delta to all sockets' subscriptions
*   - A channel name (Buffer/ArrayBuffer/string): applies delta to all subscribers of this source channel
*   - An array mixing socket IDs and channel names: applies delta to sockets and source channel subscribers
* @param channelName - The target channel name (Buffer, ArrayBuffer, or string).
* @param delta - Optional. The amount to change the subscription count by (default: 1). 
*   Positive values add subscriptions, negative values remove them. When the count reaches zero, the subscription is removed.
* @returns An array of socket IDs that were affected by the operation:
*   - For positive delta: socket IDs that became newly subscribed (reference count went from 0 to positive)
*   - For negative delta: socket IDs that became completely unsubscribed (reference count reached 0)
*/
export const subscribe = addon.subscribe;

/**
 * Exactly the same as {@link subscribe}, only with a negative delta (defaulting to 1, which means a single unsubscribe, or a subscribe with delta -1).
 */
export function unsubscribe(socketIdOrChannelName: number | number[] | Uint8Array | ArrayBuffer | string | (number | Uint8Array | ArrayBuffer | string)[], channelName: Uint8Array | ArrayBuffer | string, delta: number = 1): number[] {
    return addon.subscribe(socketIdOrChannelName, channelName, -delta);
}

/** 
* @deprecated Use subscribe(fromChannelName, toChannelName) instead.
* Copies all subscribers from one channel to another channel. Uses reference counting - if a subscriber 
* is already subscribed to the destination channel, their reference count will be incremented instead 
* of creating duplicate subscriptions.
* @param fromChannelName - The source channel name (Buffer, ArrayBuffer, or string).
* @param toChannelName - The destination channel name (Buffer, ArrayBuffer, or string).
* @returns An array of socket IDs that were newly added to the destination channel. Sockets that were 
*   already subscribed (and had their reference count incremented) are not included.
*/
export function copySubscriptions(fromChannelName: Uint8Array | ArrayBuffer | string, toChannelName: Uint8Array | ArrayBuffer | string): number[] {
    const result = addon.subscribe(fromChannelName, toChannelName);
    return result as number[];
}

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
