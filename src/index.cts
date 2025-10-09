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
    function createVirtualSocket(socketId: number, userPrefix?: Uint8Array | ArrayBuffer | string): number;
    function deleteVirtualSocket(virtualSocketId: number, expectedTargetSocketId?: number): boolean;
    function getKey(key: Uint8Array | ArrayBuffer | string): Uint8Array | undefined;
    function setKey(key: Uint8Array | ArrayBuffer | string, value?: Uint8Array | ArrayBuffer | string | undefined): Uint8Array | undefined;
    function setKeyIf(key: Uint8Array | ArrayBuffer | string, newValue?: Uint8Array | ArrayBuffer | string | undefined, checkValue?: Uint8Array | ArrayBuffer | string | undefined): boolean;
}

/**
* Interface that worker threads must implement to handle WebSocket events.
* All handler methods are optional - if not provided, the respective functionality will be unavailable.
*/
export interface WorkerInterface {
    /**
    * Called when the worker is starting up, before registering with the native addon.
    * This allows for initialization logic that needs to run before handling WebSocket events.
    * @param workerArg - Optional argument passed from the start() function's workerArg option.
    */
    handleStart?(workerArg?: any): Promise<void> | void;
    
    /**
    * Handles new WebSocket connections and can reject them. If not provided, all connections are accepted.
    * @param socketId - The unique identifier of the WebSocket connection.
    * @param ip - The client's IP address.
    * @param headers - HTTP headers from the WebSocket handshake request.
    * @returns true to accept the connection, false to reject it.
    */
    handleOpen?(socketId: number, ip: string, headers: Record<string, string>): Promise<boolean> | boolean;
    
    /**
    * Handles incoming WebSocket text messages from clients.
    * @param data - The message data as a string.
    * @param socketId - The unique identifier of the WebSocket connection.
    */
    handleTextMessage?(data: string, socketId: number): Promise<void> | void;

    /**
    * Handles incoming WebSocket binary messages from clients.
    * @param data - The message data as a Uint8Array.
    * @param socketId - The unique identifier of the WebSocket connection.
    */
    handleBinaryMessage?(data: Uint8Array, socketId: number): Promise<void> | void;

    /**
    * Handles WebSocket connection closures.
    * @param socketId - The unique identifier of the closed WebSocket connection.
    */
    handleClose?(socketId: number): Promise<void> | void;
}

// Internal map to keep Worker instances alive and allow termination
const workers = new Map<number, {worker: Worker, lastSeen: number}>();

// Worker monitoring state
const WORKER_TIMEOUT_MS = 3000; // 3 seconds timeout
let monitoringInterval: NodeJS.Timeout | null = null;

/*
* Start the worker monitoring system that pings workers and terminates hanging ones.
*/
function startMonitoring() {
    if (monitoringInterval) return; // Already running
    
    monitoringInterval = setInterval(() => {
        const now = Date.now();

        for (const [workerId, worker] of workers) {
            const timeSinceLastSeen = now - worker.lastSeen;
            if (timeSinceLastSeen > WORKER_TIMEOUT_MS) {
                console.error(`WarpSocket worker ${workerId} unresponsive for ${timeSinceLastSeen}ms, terminating`);
                workers.delete(workerId);
                addon.deregisterWorkerThread(workerId);
                worker.worker.terminate();
                spawnWorker(); // Start a replacement worker
            }

            worker.worker.postMessage({ type: '__ping', timestamp: now });
        }
        
        // Stop monitoring if no workers left
        if (workers.size === 0) {
            clearInterval(monitoringInterval!);
            monitoringInterval = null;
        }
    }, 500); // Check twice per second
}

let workerData: {workerPath: string, workerArg: any} | undefined;


/** 
 * Starts a WebSocket server bound to the given address and spawns worker threads
 * that handle WebSocket events.
 *
 * @param options - Configuration object:
 *   * bind: Required. Address string to bind the server to (e.g. "127.0.0.1:8080"),
 *           or an array of such strings to bind multiple addresses.
 *   * workerPath: Required. Path (absolute or relative to process.cwd()) to the
 *                 worker JavaScript module. This module will be imported in each
 *                 worker thread and its exported handlers will be registered with
 *                 the native addon. Worker modules may export any subset of the
 *                 `WorkerInterface` handlers.
 *   * threads: Optional. Number of worker threads to spawn. When a positive
 *              integer is provided, that number of Node.js `Worker` threads
 *              are created and set up to handle WebSocket events. When omitted,
 *              defaults to the number of CPU cores or 4, whichever is higher.
 *   * workerArg: Optional. Argument to pass to the handleStart() method of
 *                worker modules, if they implement it. This allows passing
 *                initialization data or configuration to workers.
 *
 * @returns A Promise that resolves after worker threads (if any) have been
 *          started and the native addon has been instructed to bind to the
 *          address. The Promise rejects if worker initialization fails.
 *
 * @throws If `options` is or the `bind` and `workerPath` properties are 
 *         missing or invalid, or if already started.
 */

export async function start(options: { bind: string | string[], workerPath?: string, threads?: number, workerArg?: any }): Promise<void> {
    if (workerData) {
        throw new Error('already started');
    }
    if (!options || !options.bind || !options.workerPath) {
        throw new Error('options.bind and options.workerPath are required');
    }

    if (!pathMod.isAbsolute(options.workerPath)) {
        options.workerPath = pathMod.resolve(process.cwd(), options.workerPath);
    }
    workerData = {workerPath: options.workerPath, workerArg: options.workerArg};

    options.threads = options.threads == null ? Math.max(os.cpus()?.length || 1, 4) : Math.max(1, 0|options.threads);

    // console.log(`WarpSocket starting`, options);

    // Start a single worker first.. allow it to fail and throw before starting more
    await spawnWorker();

    // Now start and await the rest in parallel
    const promises = [];
    for (let i = 1; i < options.threads; i++) {
        promises.push(spawnWorker());
    }
    await Promise.all(promises);

    if (Array.isArray(options.bind)) {
        for (const b of options.bind) addon.start(b);
    } else {
        addon.start(options.bind);
    }
}

const BOOTSTRAP_WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const addon = require('warpsocket/addon-loader');

// Handle ping messages from main thread
parentPort.on('message', (msg) => {
    if (msg && msg.type === '__ping') {
        parentPort.postMessage({ type: '__pong', timestamp: msg.timestamp });
    }
});

(async () => {
    const workerModule = await import(workerData.workerPath);
    
    // Call handleStart if it exists, passing workerArg
    if (typeof workerModule.handleStart === 'function') {
        await workerModule.handleStart(workerData.workerArg);
    }
    
    const workerId = addon.registerWorkerThread(workerModule);
    parentPort.postMessage({ type: 'registered', workerId });
})();
`;

function spawnWorker(): Promise<void> { 
    return new Promise<void>((resolve, reject) => {
        let running = false;
        const w = new Worker(BOOTSTRAP_WORKER, {
            eval: true,
            workerData
        });

        let workerId: number;

        w.on('message', (msg) => {
            if (msg && (msg as any).type === 'registered') {
                workerId = (msg as any).workerId;
                workers.set(workerId, {worker: w, lastSeen: Date.now()});
                // console.log(`WarpSocket worker #${workerId} registered`);
                startMonitoring(); // Start monitoring when we have workers
                running = true;
                resolve();
            } else if (msg && (msg as any).type === '__pong') {
                workers.get(workerId)!.lastSeen = Date.now();
            }
        });

        w.on('error', (err) => {
            console.error('WarpSocket worker thread error:', err);
        });

        w.on('exit', (code) => {
            if (!workers.has(workerId)) return;
            console.error('WarpSocket worker thread exited with code', code);
            workers.delete(workerId);
            addon.deregisterWorkerThread(workerId);
            if (running) {
                // Start a replacement worker
                spawnWorker();
            } else {
                reject(new Error(`Could not start worker`));
            }
        });

    });
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
* When target is a virtual socket with user prefix (or a channel that has such a subscriber), that prefix is prepended to the message. In case of a text message, the prefix bytes are assumed to be valid UTF-8.
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
 * Exactly the same as `subscribe`, only with a negative delta (defaulting to 1, which means a single unsubscribe, or a subscribe with delta -1).
 */
export function unsubscribe(socketIdOrChannelName: number | number[] | Uint8Array | ArrayBuffer | string | (number | Uint8Array | ArrayBuffer | string)[], channelName: Uint8Array | ArrayBuffer | string, delta: number = 1): number[] {
    return addon.subscribe(socketIdOrChannelName, channelName, -delta);
}

/** 
* **DEPRECATED:** Use subscribe(fromChannelName, toChannelName) instead.
* 
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
 * @param userPrefix - Optional user prefix (up to 15 bytes) that will be prepended to all messages sent to this virtual socket (possibly through a channel). For text messages, this prefix is assumed to be valid UTF-8.
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

/**
 * Reads the raw bytes stored for a key in the shared in-memory store.
 * @param key - Key to read (Buffer, ArrayBuffer, or string).
 * @returns A Uint8Array when the key exists, or undefined otherwise.
 */
export const getKey = addon.getKey;

/**
 * Stores or deletes a value in the shared key/value store.
 * @param key - Key to upsert (Buffer, ArrayBuffer, or string).
 * @param value - Optional value to store. Pass `undefined` to delete the key instead.
 * @returns The previous value as a Uint8Array when the key existed, or undefined if it did not.
 */
export const setKey = addon.setKey;

/**
 * Atomically updates a key only when its current value matches the expected check value.
 * @param key - Key to update (Buffer, ArrayBuffer, or string).
 * @param newValue - Optional replacement value. Pass `undefined` to delete the key on success.
 * @param checkValue - Optional expected value. Pass `undefined` to require that the key is absent.
 * @returns true when the compare-and-set succeeds, false otherwise.
 */
export const setKeyIf = addon.setKeyIf;
