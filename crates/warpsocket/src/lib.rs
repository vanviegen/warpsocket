use std::net::SocketAddr;
use std::collections::{HashMap};
use std::time::Duration;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::time;
use http::StatusCode;
use tokio_tungstenite::{
    accept_async,
    accept_hdr_async,
    tungstenite::{
        protocol::Message,
        handshake::server::{Request, Response, ErrorResponse},
        protocol::{CloseFrame, frame::coding::CloseCode},
    },
};
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use dashmap::DashMap;
use dashmap::mapref::one::Ref as DashRef;
use lazy_static::lazy_static;
use neon::prelude::*;
use neon::types::buffer::TypedArray;
use neon::event::Channel;
use std::sync::Arc;

type Sender = futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<TcpStream>, Message>;
type Bytes = Vec<u8>;

macro_rules! convert_arg {
    ($cx:expr, $val:expr, Message) => {{
        js_value_to_message($cx, $val)
    }};
    ($cx:expr, $val:expr, Bytes) => {{
        js_value_to_bytes($cx, $val)
    }};
    ($cx:expr, $val:expr, u64) => {{
        $val.downcast::<JsNumber, _>($cx).map(|s| s.value($cx) as u64)
    }};
    ($cx:expr, $val:expr, i32) => {{
        $val.downcast::<JsNumber, _>($cx).map(|s| s.value($cx) as i32)
    }};
    ($cx:expr, $val:expr, String) => {{
        $val.downcast::<JsString, _>($cx).map(|s| s.value($cx))
    }};
    ($cx:expr, $val:expr, $type:ident) => {{
        $val.downcast::<$type, _>($cx)
    }};

}

// Required argument: throws on missing or wrong type, returns the final converted value.
macro_rules! read_arg {
    ($cx:expr, $index:expr, $ty:ident) => {{
        match $cx.argument_opt($index) {
            Some(v) => {
                if let Ok(converted) = convert_arg!($cx, v, $ty) {
                    converted
                } else {
                    return $cx.throw_type_error(format!(
                        "Expected argument {} to be a {}",
                        $index + 1,
                        std::any::type_name::<$ty>()
                    ));
                }
            }
            None => return $cx.throw_type_error(format!("Missing argument {}", $index + 1)),
        }
    }};
}

// Optional argument: returns Option<converted>, throwing only when provided but of wrong type.
macro_rules! read_arg_opt {
    ($cx:expr, $index:expr, $ty:ident) => {{
        match $cx.argument_opt($index) {
            Some(v) => {
                if let Ok(converted) = convert_arg!($cx, v, $ty) {
                    Some(converted)
                } else {
                    if let Ok(_) = v.downcast::<JsUndefined, _>($cx) {
                        None
                    } else {
                        return $cx.throw_type_error(format!(
                            "Expected argument {} to be a {}",
                            $index + 1,
                            std::any::type_name::<$ty>()
                        ));
                    }
                }
            }
            None => None
        }
    }};
}

enum SocketEntry {
    // Actual WebSocket connection with sender and optional token
    Actual {
        sender_mutex: tokio::sync::Mutex<Sender>,
        token: Option<Vec<u8>>,
    },
    // Virtual socket pointing to another socket ID (which may be actual or virtual)
    Virtual {
        target_socket_id: u64,
        user_data: Option<i32>,
    },
}

lazy_static! {
    // Maps channel names subscribes socket ids and their refCounts (channelName: {socketId: refCount})
    static ref CHANNELS: DashMap<Vec<u8>, HashMap<u64,u16>> = DashMap::new();
    // Maps socket IDs to their SocketEntry (actual or virtual)
    static ref SOCKETS: DashMap<u64, SocketEntry> = DashMap::new();
    // Maps worker thread IDs to their associated WorkerThread instances
    static ref WORKERS: DashMap<u64, Worker> = DashMap::new();
    // Vector of alive worker IDs for efficient round-robin selection
    static ref WORKER_IDS: std::sync::RwLock<Vec<u64>> = std::sync::RwLock::new(Vec::new());
    // Global runtime for executing async operations from sync contexts
    static ref RUNTIME: tokio::runtime::Runtime = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");
}

// Atomic counter for generating unique socket IDs
static SOCKET_COUNTER: AtomicU64 = AtomicU64::new(1);
// Atomic counter for generating unique worker thread IDs
static WORKER_COUNTER: AtomicU64 = AtomicU64::new(0);
// Round-robin counter for worker selection
static ROUND_ROBIN_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct Worker {
    channel: Channel,
    text_message_handler: Option<Arc<Root<JsFunction>>>,
    binary_message_handler: Option<Arc<Root<JsFunction>>>,
    close_handler: Option<Arc<Root<JsFunction>>>,
    open_handler: Option<Arc<Root<JsFunction>>>,
}

// Schedule a callback to run in the worker's main JavaScript thread
// Returns false if the worker is dead/not found, true on success
fn schedule_in_worker_main_thread<F>(worker_id: u64, js_callback: F) -> bool
where
    F: for<'a> FnOnce(neon::context::Cx<'a>) -> NeonResult<()> + Send + 'static,
{
    if let Some(worker_ref) = WORKERS.get(&worker_id) {
        let channel = worker_ref.channel.clone();
        drop(worker_ref); // Release the DashMap reference before the potentially blocking call

        channel.send(js_callback);
        true
    } else {
        false
    }
}





struct SocketRef<'a> {
    // Hold the DashMap guard to keep the underlying value alive
    _guard: DashRef<'a, u64, SocketEntry>,
    // Direct references to the fields, tied to the guard's lifetime
    pub sender_mutex: &'a tokio::sync::Mutex<Sender>,
    pub token: &'a Option<Vec<u8>>,
    pub user_data: Option<i32>,
}

// Get a reference to an actual socket, following virtual sockets.
// The returned SocketRef holds the DashMap guard to ensure the references are valid.
fn get_socket(socket_id: u64) -> Option<SocketRef<'static>> {
    let mut current_id = socket_id;
    let mut first_user_data: Option<i32> = None;

    loop {
        if let Some(guard) = SOCKETS.get(&current_id) {
            match guard.value() {
                SocketEntry::Actual { sender_mutex, token } => {
                    // SAFETY: We're transmuting the lifetime to 'static, but the guard
                    // is moved into SocketRef and will keep the references valid.
                    // This is safe because the SocketRef owns the guard.
                    let sender_mutex_ref = unsafe { std::mem::transmute(sender_mutex) };
                    let token_ref = unsafe { std::mem::transmute(token) };
                    
                    return Some(SocketRef {
                        sender_mutex: sender_mutex_ref,
                        token: token_ref,
                        user_data: first_user_data,
                        _guard: guard,
                    });
                }
                SocketEntry::Virtual { target_socket_id, user_data } => {
                    if first_user_data.is_none() {
                        first_user_data = *user_data;
                    }
                    // Drop current guard before following the chain
                    current_id = *target_socket_id;
                    // loop continues
                }
            }
        } else {
            return None;
        }
    }
}

// Helper function to send a message to a single socket, handling user data attachment
async fn send_to_socket(socket_id: u64, message: &Message) -> bool {
    if let Some(s) = get_socket(socket_id) {
        let final_message = if let Some(user_data) = s.user_data {
            // Include user data
            match message {
                // Text: assume JSON, add _vsud key
                Message::Text(text) => {
                    if !text.starts_with('{') || !text.ends_with('}') {
                        eprintln!(
                            "To attach the socket id to a text message, it must be a JSON object, not: {}",
                            text
                        );
                    }
                    if text.find('"').is_some() {
                        Message::Text(format!("{{\"_vsud\":{},{}", user_data, &text[1..]))
                    } else {
                        // Empty JSON object
                        Message::Text(format!("{{\"_vsud\":{}}}", user_data))
                    }
                }
                // Binary: prefix i32 bytes in network order
                Message::Binary(data) => {
                    let mut prefixed = user_data.to_be_bytes().to_vec();
                    prefixed.extend_from_slice(data);
                    Message::Binary(prefixed)
                }
                _ => message.clone(),
            }
        } else {
            message.clone()
        };
        
        let mut sender = s.sender_mutex.lock().await;
        if let Err(e) = sender.send(final_message).await {
            println!("Send failed: {}", e);
            false
        } else {
            true
        }
    } else {
        false
    }
}

fn start(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let bind_str = read_arg!(&mut cx, 0, String);

    let bind_addr = match bind_str.parse::<SocketAddr>() {
        Ok(addr) => addr,
        Err(_) => return cx.throw_error("Invalid bind address"),
    };

    // Check that at least one worker is registered
    {
        let worker_ids = WORKER_IDS.read().unwrap();
        if worker_ids.is_empty() {
            return cx.throw_error("At least one worker must be registered before starting the server");
        }
    }
    
    // Try to bind synchronously so we can report errors back to JS
    let listener = match RUNTIME.block_on(async { TcpListener::bind(&bind_addr).await }) {
        Ok(listener) => listener,
        Err(e) => return cx.throw_error(format!("Failed to bind to {}: {}", bind_addr, e)),
    };
    
    // Use the global runtime to spawn the server with the bound listener
    RUNTIME.spawn(async move {
        start_server(listener).await;
    });
    
    
    Ok(cx.undefined())
}

fn register_worker_thread(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let worker_obj = read_arg!(&mut cx, 0, JsObject);

    let text_message_handler = worker_obj.get_opt::<JsFunction, _, _>(&mut cx, "handleTextMessage")?.map(|f| Arc::new(f.root(&mut cx)));
    let binary_message_handler = worker_obj.get_opt::<JsFunction, _, _>(&mut cx, "handleBinaryMessage")?.map(|f| Arc::new(f.root(&mut cx)));
    let close_handler = worker_obj.get_opt::<JsFunction, _, _>(&mut cx, "handleClose")?.map(|f| Arc::new(f.root(&mut cx)));
    let open_handler = worker_obj.get_opt::<JsFunction, _, _>(&mut cx, "handleOpen")?.map(|f| Arc::new(f.root(&mut cx)));
    
    let worker_id = WORKER_COUNTER.fetch_add(1, Ordering::Relaxed);
    
    let worker = Worker {
        channel: cx.channel(),
        text_message_handler,
        binary_message_handler,
        close_handler,
        open_handler,
    };
    
    WORKERS.insert(worker_id, worker);
    
    // Add to the worker IDs list
    if let Ok(mut worker_ids) = WORKER_IDS.write() {
        worker_ids.push(worker_id);
    }
    
    Ok(cx.number(worker_id as f64))
}

// Simple function to kill a worker process by PID
fn deregister_worker_thread(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let worker_id = read_arg!(&mut cx, 0, u64);
    let result = if let Some((_, _worker)) = WORKERS.remove(&worker_id) {
        eprintln!("Removed worker {} from pool", worker_id);

        // Remove from the worker IDs list
        let mut worker_ids = WORKER_IDS.write().unwrap();
        worker_ids.retain(|&id| id != worker_id);

        true
    } else {
        false
    };

    Ok(cx.boolean(result))
}

fn send(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let target = read_arg!(&mut cx, 0, JsValue);
    let message = read_arg!(&mut cx, 1, Message);

    // Extract all targets into vectors (must be done synchronously with cx)
    let mut socket_targets = Vec::new();
    let mut channel_targets = Vec::new();
    
    if let Ok(array) = target.downcast::<JsArray, _>(&mut cx) {
        // Array of socket IDs or channel names
        let len = array.len(&mut cx) as usize;
        for i in 0..len {
            if let Ok(element) = array.get::<JsValue, _, _>(&mut cx, i as u32) {
                if let Ok(num) = element.downcast::<JsNumber, _>(&mut cx) {
                    socket_targets.push(num.value(&mut cx) as u64);
                } else if let Ok(channel_bytes) = js_value_to_bytes(&mut cx, element) {
                    channel_targets.push(channel_bytes);
                } else {
                    return cx.throw_type_error("Array elements must be numbers (socket IDs) or channel names (Buffer/ArrayBuffer/String)");
                }
            }
        }
    } else if let Ok(num) = target.downcast::<JsNumber, _>(&mut cx) {
        // Single socket ID
        socket_targets.push(num.value(&mut cx) as u64);
    } else if let Ok(channel_bytes) = js_value_to_bytes(&mut cx, target) {
        // Single channel name
        channel_targets.push(channel_bytes);
    } else {
        return cx.throw_type_error("Target must be a number (socket ID), channel name (Buffer/ArrayBuffer/String), or array of these");
    }

    // Now send to all targets asynchronously (shared code)
    let result = RUNTIME.block_on(async move {
        let mut send_count = 0;

        // Send to socket IDs
        for socket_id in socket_targets {
            if send_to_socket(socket_id, &message).await {
                send_count += 1;
            }
        }
        
        // Send to channels
        for channel_name in channel_targets {
            if let Some(subscribers) = CHANNELS.get(&channel_name) {
                // Make a copy, as we don't want to hold the lock while sending messages
                let subscriber_ids: Vec<u64> = subscribers.keys().copied().collect();
                drop(subscribers); // Just to be sure
                for socket_id in subscriber_ids {
                    if send_to_socket(socket_id, &message).await {
                        send_count += 1;
                    }
                }
            }
        }
        send_count
    });
    
    Ok(cx.number(result as f64))
}

// Helper function to apply a subscription delta to a single socket-channel pair
fn apply_subscription_delta(socket_id: u64, channel_name: &[u8], delta: i32) -> bool {
    let mut channel = CHANNELS.entry(channel_name.to_vec()).or_insert_with(HashMap::new);
    
    if delta > 0 {
        // Adding subscriptions
        if let Some(entry) = channel.get_mut(&socket_id) {
            *entry = entry.saturating_add(delta as u16);
            false // not new
        } else {
            channel.insert(socket_id, delta as u16);
            true // new
        }
    } else {
        // Removing subscriptions
        if let Some(entry) = channel.get_mut(&socket_id) {
            let new_count = entry.saturating_sub((-delta) as u16);
            if new_count == 0 {
                channel.remove(&socket_id);
                true // was removed
            } else {
                *entry = new_count;
                false // not removed
            }
        } else {
            false // wasn't subscribed
        }
    }
}

// Helper function to copy subscriptions from one channel to another with delta, collecting new socket IDs
fn copy_subscriptions_with_delta(from_channel: &[u8], to_channel: &[u8], delta: i32, new_socket_ids: &mut Vec<u64>) {
    let subscribers: Vec<u64> = CHANNELS.get(from_channel)
        .map(|channel| channel.keys().copied().collect())
        .unwrap_or_default();

    for subscriber_id in subscribers {
        // Apply delta subscription for each subscriber
        if apply_subscription_delta(subscriber_id, to_channel, delta) {
            new_socket_ids.push(subscriber_id);
        }
    }
}

// Helper function to handle a single subscription target (socket ID or channel name)
fn handle_subscription_target<'a>(cx: &mut FunctionContext<'a>, target: Handle<JsValue>, channel_name: &[u8], delta: i32, new_socket_ids: &mut Vec<u64>) -> NeonResult<()> {
    if let Ok(num) = target.downcast::<JsNumber, _>(cx) {
        // Socket ID
        let socket_id = num.value(cx) as u64;
        if apply_subscription_delta(socket_id, channel_name, delta) {
            new_socket_ids.push(socket_id);
        }
        Ok(())
    } else if let Ok(from_channel_bytes) = js_value_to_bytes(cx, target) {
        // Channel name to copy from (supports both positive and negative delta)
        copy_subscriptions_with_delta(&from_channel_bytes, channel_name, delta, new_socket_ids);
        Ok(())
    } else {
        cx.throw_type_error("Target must be a number (socket ID) or channel name (Buffer/ArrayBuffer/String)")
    }
}

fn subscribe(mut cx: FunctionContext) -> JsResult<JsArray> {
    let target = read_arg!(&mut cx, 0, JsValue);
    let channel_name = read_arg!(&mut cx, 1, Bytes);
    let delta: i32 = read_arg_opt!(&mut cx, 2, i32).unwrap_or(1);
    
    let mut new_socket_ids = Vec::new();
    
    if let Ok(array) = target.downcast::<JsArray, _>(&mut cx) {
        // Array of socket IDs or channel names
        let len = array.len(&mut cx) as usize;
        
        for i in 0..len {
            if let Ok(element) = array.get::<JsValue, _, _>(&mut cx, i as u32) {
                handle_subscription_target(&mut cx, element, &channel_name, delta, &mut new_socket_ids)?;
            } else {
                return cx.throw_type_error("Invalid array element");
            }
        }
    } else {
        // Single target (socket ID or channel name)
        handle_subscription_target(&mut cx, target, &channel_name, delta, &mut new_socket_ids)?;
    }
    
    // Return array of newly subscribed socket IDs
    let js_array = cx.empty_array();
    for (i, socket_id) in new_socket_ids.iter().enumerate() {
        let js_number = cx.number(*socket_id as f64);
        js_array.set(&mut cx, i as u32, js_number)?;
    }
    Ok(js_array)
}

fn set_token(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let socket_id = read_arg!(&mut cx, 0, u64);
    let token_bytes = read_arg!(&mut cx, 1, Bytes);

    if let Some(mut entry) = SOCKETS.get_mut(&socket_id) {
        if let SocketEntry::Actual { token, .. } = entry.value_mut() {
            *token = Some(token_bytes.clone());
            return Ok(cx.undefined());
        }
    }
    return cx.throw_error("Socket not found");
}

fn has_subscription(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let channel_name = read_arg!(&mut cx, 0, Bytes);

    // Check if the channel exists
    let has_active = if let Some(channel) = CHANNELS.get(&channel_name) {
        // Check if any subscriber resolves to an actual active socket (short-circuits on first match)
        channel.keys().any(|socket_id| get_socket(*socket_id).is_some())
    } else {
        false
    };
    Ok(cx.boolean(has_active))
}

fn create_virtual_socket(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let target_socket_id = read_arg!(&mut cx, 0, u64);
    let user_data: Option<i32> = read_arg_opt!(&mut cx, 1, i32);
    
    let virtual_socket_id = SOCKET_COUNTER.fetch_add(1, Ordering::Relaxed);

    SOCKETS.insert(virtual_socket_id, SocketEntry::Virtual { target_socket_id, user_data });
    
    Ok(cx.number(virtual_socket_id as f64))
}

fn delete_virtual_socket(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let virtual_socket_id = read_arg!(&mut cx, 0, u64);
    let expected_target_socket_id: Option<u64> = read_arg_opt!(&mut cx, 1, u64);

    let opt_pair = SOCKETS.remove_if(&virtual_socket_id, |_key,val| match val {
        SocketEntry::Virtual { target_socket_id, .. } => expected_target_socket_id == None || expected_target_socket_id == Some(*target_socket_id),
        SocketEntry::Actual { .. } => false,
    });

    Ok(cx.boolean(if let Some(..) = opt_pair {
        true
    } else {
        false
    }))
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

async fn start_server(listener: TcpListener) {
    // Cleanup task
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_secs(10));
        loop {
            interval.tick().await;
            cleanup_disconnected_connections();
        }
    });
    
    while let Ok((stream, _)) = listener.accept().await {
        tokio::spawn(handle_connection(stream));
    }
}

async fn handle_connection(stream: TcpStream) {
    let peer_addr = stream.peer_addr().ok();
    
    // Select a worker for this connection using round-robin
    let worker_id = {
        let worker_ids = WORKER_IDS.read().unwrap();
        if worker_ids.is_empty() {
            eprintln!("No workers available for new connection");
            return;
        }
        let index = ROUND_ROBIN_COUNTER.fetch_add(1, Ordering::Relaxed) % worker_ids.len() as u64;
        worker_ids[index as usize]
    };
    
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
            
            // Use a blocking channel to get the result from the JS callback
            let (tx, rx) = std::sync::mpsc::channel();
            
            let send_result = schedule_in_worker_main_thread(worker_id, move |mut cx| {
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

                let should_accept = match result {
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
            
            if !send_result {
                // Worker is dead or not found, reject the connection
                let mut parts = response.into_parts().0;
                parts.status = StatusCode::INTERNAL_SERVER_ERROR;
                let error_response = ErrorResponse::from_parts(parts, Some("Worker unavailable".to_string()));
                return Err(error_response);
            }

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
            if e.to_string() != "WebSocket protocol error: Handshake not finished" {
                eprintln!("WebSocket connection failed: {}", e);
            }
            return;
        }
    };
    
    let (ws_sender, mut ws_receiver) = ws_stream.split();
    
    // Store the WebSocket sender in global map
    SOCKETS.insert(socket_id, SocketEntry::Actual {
        sender_mutex: tokio::sync::Mutex::new(ws_sender),
        token: None,
    });
    
    // Handle incoming messages
    while let Some(msg) = ws_receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if !handle_socket_message(worker_id, socket_id, Message::Text(text)).await {
                    break; // Worker is dead, terminate the connection
                }
            }
            Ok(Message::Binary(data)) => {
                if !handle_socket_message(worker_id, socket_id, Message::Binary(data)).await {
                    break; // Worker is dead, terminate the connection
                }
            }
            Ok(Message::Close(_)) => break,
            _ => {}
        }
    }
    
    // Remove the socket from the dashmap
    let socket = SOCKETS.remove(&socket_id).unwrap().1;

    // Call close handler
    if let Some(worker_ref) = WORKERS.get(&worker_id) {
        if let Some(handler) = &worker_ref.close_handler {
            let handler = Arc::clone(handler);
            
            schedule_in_worker_main_thread(worker_id, move |mut cx| {
                let callback = handler.to_inner(&mut cx);
                
                let js_socket_id = cx.number(socket_id as f64).upcast();
                let js_token = match socket {
                    SocketEntry::Actual { token: Some(token), .. } => create_js_buffer(&mut cx, &token)?.upcast::<JsValue>(),
                    _ => cx.undefined().upcast(),
                };

                invoke_js_callback(&mut cx, callback, vec![js_socket_id, js_token]);

                Ok(())
            });
        }
    }
}

async fn handle_socket_message(worker_id: u64, socket_id: u64, message: Message) -> bool {
    if let Some(worker_ref) = WORKERS.get(&worker_id) {
        let opt_handler = match message {
            Message::Text(_) => &worker_ref.text_message_handler,
            Message::Binary(_) => &worker_ref.binary_message_handler,
            _ => &None
        };

        if let Some(handler) = opt_handler {
            let handler = Arc::clone(handler);
            
            // Copy the token while holding the guard
            let token_copy = get_socket(socket_id).and_then(|s| s.token.clone());
            
            let result = schedule_in_worker_main_thread(worker_id, move |mut cx| {
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
                
                let js_token = match token_copy {
                    Some(token_data) => create_js_buffer(&mut cx, &token_data)?.upcast::<JsValue>(),
                    None => cx.null().upcast(),
                };
                
                invoke_js_callback(&mut cx, callback, vec![js_data,js_socket_id.upcast(),js_token,]);
                
                Ok(())
            });
            
            if !result {
                // Send a proper WebSocket close frame before terminating
                if let Some(socket_ref) = get_socket(socket_id) {
                    let mut sender = socket_ref.sender_mutex.lock().await;
                    let _ = sender.send(Message::Close(Some(CloseFrame {
                        code: CloseCode::Error,
                        reason: "Server worker unavailable".into(),
                    }))).await;
                }
                
                return false; // Signal that the connection should be terminated
            }
        }
        true // Continue processing messages
    } else {
        // Send a proper WebSocket close frame before terminating
        if let Some(socket_ref) = get_socket(socket_id) {
            let mut sender = socket_ref.sender_mutex.lock().await;
            let _ = sender.send(Message::Close(Some(CloseFrame {
                code: CloseCode::Error,
                reason: "Server worker is down".into(),
            }))).await;
        }
        
        false // Terminate connection if worker doesn't exist
    }
}

fn cleanup_disconnected_connections() {
    // Clean up virtual sockets that point to non-existent actual sockets
    SOCKETS.retain(|_key, entry| {
        match entry {
            SocketEntry::Virtual { target_socket_id, user_data: _ } => get_socket(*target_socket_id).is_some(),
            SocketEntry::Actual { .. } => true,
        }
    });

    // Cleanup subscribers pointing at non-existent sockets and channels without subscribers
    CHANNELS.retain(|_key, subscribers| {
        subscribers.retain(|socket_id, _ref_cnt| SOCKETS.contains_key(socket_id));
        !subscribers.is_empty()
    });
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("start", start)?;
    cx.export_function("registerWorkerThread", register_worker_thread)?;
    cx.export_function("deregisterWorkerThread", deregister_worker_thread)?;
    cx.export_function("send", send)?;
    cx.export_function("subscribe", subscribe)?;
    cx.export_function("setToken", set_token)?;
    cx.export_function("hasSubscriptions", has_subscription)?;
    cx.export_function("createVirtualSocket", create_virtual_socket)?;
    cx.export_function("deleteVirtualSocket", delete_virtual_socket)?;
    Ok(())
}

