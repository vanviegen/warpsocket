use std::net::SocketAddr;
use std::collections::{HashSet, HashMap};
use std::time::Duration;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::time;
use http::StatusCode;
use tokio_tungstenite::{accept_async, accept_hdr_async, tungstenite::{protocol::Message, handshake::server::{Request, Response, ErrorResponse}}};
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use dashmap::DashMap;
use lazy_static::lazy_static;
use neon::prelude::*;
use neon::types::buffer::TypedArray;
use neon::event::Channel;
use std::sync::Arc;

lazy_static! {
    // Maps channel names to sets of socket IDs subscribed to each channel
    static ref CHANNELS: DashMap<Vec<u8>, HashSet<u64>> = DashMap::new();
    // Maps socket IDs to their WebSocket senders
    static ref SOCKET_SENDERS: DashMap<u64, tokio::sync::Mutex<futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<TcpStream>, Message>>> = DashMap::new();
    // Maps socket IDs to their authentication tokens
    static ref SOCKET_TOKENS: DashMap<u64, Vec<u8>> = DashMap::new();
    // Maps worker thread IDs to their associated WorkerThread instances
    static ref WORKERS: DashMap<u64, Worker> = DashMap::new();
    // Global runtime for executing async operations from sync contexts
    static ref RUNTIME: tokio::runtime::Runtime = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");
}

// Atomic counter for generating unique socket IDs
static SOCKET_COUNTER: AtomicU64 = AtomicU64::new(0);
// Atomic counter for generating unique worker thread IDs
static WORKER_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct Worker {
    channel: Channel,
    message_handler: Option<Arc<Root<JsFunction>>>,
    close_handler: Option<Arc<Root<JsFunction>>>,
    open_handler: Option<Arc<Root<JsFunction>>>,
}

fn start(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let opts = cx.argument::<JsObject>(0)?;
    let bind_str = opts.get::<JsString, _, _>(&mut cx, "bind")?.value(&mut cx);
    
    let bind_addr: SocketAddr = bind_str.parse()
    .or_else(|_| cx.throw_error("Invalid bind address"))?;
    
    // Check that at least one worker is registered
    if WORKERS.is_empty() {
        return cx.throw_error("At least one worker must be registered before starting the server");
    }
    
    // Use the global runtime to spawn the server
    RUNTIME.spawn(async move {
        start_server(bind_addr).await;
    });
    
    Ok(cx.undefined())
}

fn register_worker_thread(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker_obj = cx.argument::<JsObject>(0)?;
    
    let message_handler = worker_obj.get_opt::<JsFunction, _, _>(&mut cx, "handleMessage")?
    .map(|f| Arc::new(f.root(&mut cx)));
    let close_handler = worker_obj.get_opt::<JsFunction, _, _>(&mut cx, "handleClose")?
    .map(|f| Arc::new(f.root(&mut cx)));
    let open_handler = worker_obj.get_opt::<JsFunction, _, _>(&mut cx, "handleOpen")?
    .map(|f| Arc::new(f.root(&mut cx)));
    
    let worker_id = WORKER_COUNTER.fetch_add(1, Ordering::Relaxed);
    let worker = Worker {
        channel: cx.channel(),
        message_handler,
        close_handler,
        open_handler,
    };
    
    WORKERS.insert(worker_id, worker);
    
    Ok(cx.undefined())
}

fn send(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let socket_id = cx.argument::<JsNumber>(0)?.value(&mut cx) as u64;
    let arg1 = cx.argument::<JsValue>(1)?;
    let message = js_value_to_message(&mut cx, arg1)?;
    
    if let Some(sender_ref) = SOCKET_SENDERS.get(&socket_id) {
        RUNTIME.block_on(async move {
            let mut guard = sender_ref.lock().await;
            let _ = guard.send(message).await;
        });
    }
    
    Ok(cx.undefined())
}

fn send_to_channel(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let arg0 = cx.argument::<JsValue>(0)?;
    let channel_name = js_value_to_bytes(&mut cx, arg0)?;
    let arg1 = cx.argument::<JsValue>(1)?;
    let message = js_value_to_message(&mut cx, arg1)?;
    
    if let Some(subscribers) = CHANNELS.get(&channel_name) {
        let subscriber_ids: Vec<u64> = subscribers.iter().copied().collect();
        
        RUNTIME.block_on(async move {
            for socket_id in subscriber_ids {
                if let Some(sender_ref) = SOCKET_SENDERS.get(&socket_id) {
                    let mut guard = sender_ref.lock().await;
                    let _ = guard.send(message.clone()).await;
                }
            }
        });
    }
    
    Ok(cx.undefined())
}

fn subscribe(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let socket_id = cx.argument::<JsNumber>(0)?.value(&mut cx) as u64;
    let arg1 = cx.argument::<JsValue>(1)?;
    let channel_name = js_value_to_bytes(&mut cx, arg1)?;
    
    let was_inserted = CHANNELS.entry(channel_name).or_insert_with(HashSet::new).insert(socket_id);
    
    Ok(cx.boolean(was_inserted))
}

fn unsubscribe(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let socket_id = cx.argument::<JsNumber>(0)?.value(&mut cx) as u64;
    let arg1 = cx.argument::<JsValue>(1)?;
    let channel_name = js_value_to_bytes(&mut cx, arg1)?;
    
    let was_removed = if let Some(mut channel) = CHANNELS.get_mut(&channel_name) {
        channel.remove(&socket_id)
    } else {
        false
    };
    
    Ok(cx.boolean(was_removed))
}

fn set_token(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let socket_id = cx.argument::<JsNumber>(0)?.value(&mut cx) as u64;
    let arg1 = cx.argument::<JsValue>(1)?;
    let token = js_value_to_bytes(&mut cx, arg1)?;
    
    SOCKET_TOKENS.insert(socket_id, token);
    
    Ok(cx.undefined())
}

fn copy_subscriptions(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let arg0 = cx.argument::<JsValue>(0)?;
    let from_channel = js_value_to_bytes(&mut cx, arg0)?;
    let arg1 = cx.argument::<JsValue>(1)?;
    let to_channel = js_value_to_bytes(&mut cx, arg1)?;
    
    // Create a local copy of subscribers to avoid holding read lock on from_channel
    // while acquiring write lock on to_channel, preventing deadlocks
    let subscribers: Vec<u64> = CHANNELS.get(&from_channel)
    .map(|channel| channel.iter().copied().collect())
    .unwrap_or_default();
    
    if !subscribers.is_empty() {
        let mut to = CHANNELS.entry(to_channel).or_insert_with(HashSet::new);
        for subscriber_id in subscribers {
            to.insert(subscriber_id);
        }
    }
    
    Ok(cx.undefined())
}

// Must be called from the main thread for this js context
fn invoke_js_callback<'a, C: Context<'a>>(
    cx: &mut C,
    callback: Handle<JsFunction>,
    args: Vec<Handle<JsValue>>,
) -> Option<Handle<'a, JsValue>> {
    let result = cx.try_catch(|cx_inner| {
        let undefined = cx_inner.undefined();
        callback.call(cx_inner, undefined, args)
    });

    match result {
        Ok(value) => Some(value),
        Err(err) => {
            if let Ok(obj) = err.downcast::<neon::types::JsObject, _>(cx) {
                if let Ok(stack_val) = obj.get::<JsValue, _, _>(cx, "stack") {
                    if let Ok(stack) = stack_val.downcast::<neon::types::JsString, _>(cx) {
                        eprintln!("Error in callback:\n{}", stack.value(cx));
                        return None;
                    }
                }
            }
            // Fallback to stringified exception
            let msg = format!("{:?}", err);
            eprintln!("Error in callback: {}", msg);
            None
        }
    }
}

fn js_value_to_bytes<'a, C: Context<'a>>(cx: &mut C, value: Handle<JsValue>) -> NeonResult<Vec<u8>> {
    if let Ok(buffer) = value.downcast::<JsBuffer, _>(cx) {
        Ok(buffer.as_slice(cx).to_vec())
    } else if let Ok(array_buffer) = value.downcast::<JsArrayBuffer, _>(cx) {
        Ok(array_buffer.as_slice(cx).to_vec())
    } else if let Ok(string) = value.downcast::<JsString, _>(cx) {
        Ok(string.value(cx).into_bytes())
    } else {
        cx.throw_error("Expected Buffer, ArrayBuffer, or String")
    }
}

fn js_value_to_message<'a, C: Context<'a>>(cx: &mut C, value: Handle<JsValue>) -> NeonResult<Message> {
    if let Ok(buffer) = value.downcast::<JsBuffer, _>(cx) {
        Ok(Message::Binary(buffer.as_slice(cx).to_vec()))
    } else if let Ok(array_buffer) = value.downcast::<JsArrayBuffer, _>(cx) {
        Ok(Message::Binary(array_buffer.as_slice(cx).to_vec()))
    } else if let Ok(string) = value.downcast::<JsString, _>(cx) {
        Ok(Message::Text(string.value(cx)))
    } else {
        cx.throw_error("Expected Buffer, ArrayBuffer, or String")
    }
}

fn create_js_buffer<'a, C: Context<'a>>(cx: &mut C, data: &[u8]) -> NeonResult<Handle<'a, JsBuffer>> {
    let mut js_buf = cx.buffer(data.len())?;
    js_buf.as_mut_slice(cx).copy_from_slice(data);
    Ok(js_buf)
}

async fn start_server(bind_addr: SocketAddr) {
    // Cleanup task
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_secs(10));
        loop {
            interval.tick().await;
            cleanup_disconnected_connections();
        }
    });
    
    let listener = match TcpListener::bind(&bind_addr).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("Failed to bind to {}: {}", bind_addr, e);
            return;
        }
    };
    
    while let Ok((stream, _)) = listener.accept().await {
        tokio::spawn(handle_connection(stream));
    }
}

async fn handle_connection(stream: TcpStream) {
    let peer_addr = stream.peer_addr().ok();
    
    // Select a worker for this connection
    let worker_id = simple_rng() % WORKERS.len() as u64;
    
    // Generate socket ID early so we can use it in the handshake callback
    let socket_id = SOCKET_COUNTER.fetch_add(1, Ordering::Relaxed);
    
    let accept_result = if let Some(handler) = &WORKERS.get(&worker_id).unwrap().open_handler {
        // As 'handleOpen' is defined, we'll need setup a callback
        
        let callback = |req: &Request, response: Response| {        
            // Extract client information
            let client_ip = peer_addr.map(|addr| addr.ip().to_string()).unwrap_or_default();
            
            // Convert headers to a map
            let mut headers_map = HashMap::new();
            for (name, value) in req.headers() {
                if let Ok(value_str) = value.to_str() {
                    headers_map.insert(name.as_str().to_string(), value_str.to_string());
                }
            }
            
            let handler = Arc::clone(handler);
            let client_ip_clone = client_ip.clone();
            let headers_clone = headers_map.clone();
            
            // Use a channel to get the result from the JS callback
            let (tx, rx) = std::sync::mpsc::channel();
            
            WORKERS.get(&worker_id).unwrap().channel.send(move |mut cx| {
                let callback = handler.to_inner(&mut cx);

                let js_socket_id = cx.number(socket_id as f64);
                let js_client_ip = cx.string(&client_ip_clone);

                let headers_obj = cx.empty_object();
                for (key, value) in headers_clone {
                    let js_key = cx.string(&key);
                    let js_value = cx.string(&value);
                    headers_obj.set(&mut cx, js_key, js_value)?;
                }

                let result = invoke_js_callback(&mut cx, callback, vec![
                    js_socket_id.upcast(),
                    js_client_ip.upcast(),
                    headers_obj.upcast(),
                ]);

                let should_accept= match result {
                    Some(value) => {
                        if let Ok(boolean) = value.downcast::<JsBoolean, _>(&mut cx) {
                            boolean.value(&mut cx)
                        } else {
                            true // Default to accepting if not a boolean
                        }
                    }
                    None => false, // Reject on error
                };

                tx.send(should_accept).unwrap();
                Ok(())
            });

            // Wait for the JavaScript callback result
            let should_accept = rx.recv().unwrap();
            if should_accept {
                return Ok(response);
            } else {
                let mut parts = response.into_parts().0;
                parts.status = StatusCode::FORBIDDEN;
                let error_response = ErrorResponse::from_parts(parts, Some("Connection rejected".to_string()));
                return Err(error_response);
            }
        };
        
        accept_hdr_async(stream, callback).await
    } else {
        // Simple case, without accept callback
        accept_async(stream).await
    };
    
    let ws_stream = match accept_result {
        Ok(ws_stream) => ws_stream,
        Err(e) => {
            eprintln!("WebSocket connection failed: {}", e);
            return;
        }
    };
    
    let (ws_sender, mut ws_receiver) = ws_stream.split();
    
    // Store the WebSocket sender in global map
    SOCKET_SENDERS.insert(socket_id, tokio::sync::Mutex::new(ws_sender));
    
    // Handle incoming messages
    while let Some(msg) = ws_receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                handle_socket_message(worker_id, socket_id, Message::Text(text)).await;
            }
            Ok(Message::Binary(data)) => {
                handle_socket_message(worker_id, socket_id, Message::Binary(data)).await;
            }
            Ok(Message::Close(_)) => break,
            _ => {}
        }
    }
    
    // Get token before cleanup
    let token = SOCKET_TOKENS.get(&socket_id)
    .map(|entry| entry.clone());
    
    // Cleanup
    SOCKET_SENDERS.remove(&socket_id);
    SOCKET_TOKENS.remove(&socket_id);
    
    // Call close handler
    let worker = WORKERS.get(&worker_id).unwrap();
    if let Some(handler) = &worker.close_handler {
        let handler = Arc::clone(handler);
        
        worker.channel.send(move |mut cx| {
            let callback = handler.to_inner(&mut cx);
            let js_socket_id = cx.number(socket_id as f64);
            
            let js_token = match token {
                Some(ref token_data) => create_js_buffer(&mut cx, token_data)?.upcast::<JsValue>(),
                None => cx.null().upcast(),
            };
            
            invoke_js_callback(&mut cx, callback, vec![js_socket_id.upcast(), js_token]);

            Ok(())
        });
    }
}


async fn handle_socket_message(worker_id: u64, socket_id: u64, message: Message) {
    let worker = WORKERS.get(&worker_id).unwrap();
    if let Some(handler) = &worker.message_handler {
        let handler = Arc::clone(handler);
        let token = SOCKET_TOKENS.get(&socket_id)
        .map(|entry| entry.clone());
        
        worker.channel.send(move |mut cx| {
            let callback = handler.to_inner(&mut cx);
            
            let js_data = match message {
                Message::Text(text) => {
                    cx.string(text).upcast::<JsValue>()
                }
                Message::Binary(data) => {
                    create_js_buffer(&mut cx, &data)?.upcast::<JsValue>()
                }
                _ => cx.undefined().upcast::<JsValue>(), // Handle other message types
            };
            
            let js_socket_id = cx.number(socket_id as f64);
            
            let js_token = match token {
                Some(ref token_data) => create_js_buffer(&mut cx, token_data)?.upcast::<JsValue>(),
                None => cx.null().upcast(),
            };
            
            invoke_js_callback(&mut cx, callback, vec![js_data,js_socket_id.upcast(),js_token,]);
            
            Ok(())
        });
    }
}

fn cleanup_disconnected_connections() {
    let mut to_remove = Vec::new();
    
    for mut entry in CHANNELS.iter_mut() {
        let subscribers = entry.value_mut();
        subscribers.retain(|socket_id| SOCKET_SENDERS.contains_key(socket_id));
        
        if subscribers.is_empty() {
            to_remove.push(entry.key().clone());
        }
    }
    
    for channel_name in to_remove {
        // Atomically double check that the channel is still empty before removing
        CHANNELS.remove_if(&channel_name, |_key, value| value.is_empty());
    }
}

// Simple pseudo-random number generator state for worker selection
fn simple_rng() -> u64 {
    static RNG_STATE: AtomicU64 = AtomicU64::new(0x5DEECE66D);
    let current = RNG_STATE.load(Ordering::Relaxed);
    let next = current.wrapping_mul(0x5DEECE66D).wrapping_add(0xB);
    RNG_STATE.store(next, Ordering::Relaxed);
    next
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("start", start)?;
    cx.export_function("registerWorkerThread", register_worker_thread)?;
    cx.export_function("send", send)?;
    cx.export_function("sendToChannel", send_to_channel)?;
    cx.export_function("subscribe", subscribe)?;
    cx.export_function("unsubscribe", unsubscribe)?;
    cx.export_function("setToken", set_token)?;
    cx.export_function("copySubscriptions", copy_subscriptions)?;
    Ok(())
}

