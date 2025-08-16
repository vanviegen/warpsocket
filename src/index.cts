// This module is the CJS entry point for the library.

// The Rust addon.
import * as addon from './load.cjs';

// Use this declaration to assign types to the addon's exports,
// which otherwise by default are `any`.
declare module "./load.cjs" {
  function start(options: { bind: string }): void;
  function registerWorkerThread(worker: WorkerInterface): void;
  function send(connectionId: number, data: Uint8Array | string): void;
  function subscribe(connectionId: number, channelName: Uint8Array | string): void;
  function unsubscribe(connectionId: number, channelName: Uint8Array | string): void;
  function setToken(connectionId: number, token: Uint8Array | string): void;
  function copySubscriptions(fromChannelName: Uint8Array | string, toChannelName: Uint8Array | string): void;
}

export interface WorkerInterface {
  handleHttpRequest(request: HttpRequest, response: HttpResponse): void;
  handleSocketMessage(data: { data: Uint8Array, socketId: number, token?: Uint8Array }): WorkerCommand[];
  handleSocketClose(socketId: number): void;
}

export interface HttpRequest {
  method: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type WorkerCommand = 
  | { type: 'respond', data: Uint8Array }
  | { type: 'subscribe', channelName: Uint8Array }
  | { type: 'unsubscribe', channelName: Uint8Array }
  | { type: 'send', channelName: Uint8Array, data: Uint8Array }
  | { type: 'setToken', token: Uint8Array }
  | { type: 'copySubscriptions', fromChannel: Uint8Array, toChannel: Uint8Array };

export const start = addon.start;
export const registerWorkerThread = addon.registerWorkerThread;
export const send = addon.send;
export const subscribe = addon.subscribe;
export const unsubscribe = addon.unsubscribe;
export const setToken = addon.setToken;
export const copySubscriptions = addon.copySubscriptions;
