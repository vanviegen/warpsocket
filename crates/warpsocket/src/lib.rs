use std::net::SocketAddr;
use std::collections::{HashMap};
use std::time::Duration;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::time;
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        protocol::Message,
        handshake::server::{Request, Response},
        protocol::{CloseFrame, frame::coding::CloseCode},
    },
};
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use dashmap::DashMap;
use dashmap::mapref::entry::Entry;
use lazy_static::lazy_static;
use neon::prelude::*;
use neon::types::buffer::TypedArray;
use neon::types::JsUndefined;
use neon::event::Channel;
use std::sync::Arc;

type Sender = futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<TcpStream>, Message>;
type Bytes = Vec<u8>;

#[derive(Clone, Debug)]
struct UserPrefix {
    len: u8,
    data: [u8; 15],
}

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
    // Actual WebSocket connection with sender
    Actual {
        sender_mutex: Arc<tokio::sync::Mutex<Sender>>,
    },
    // Virtual socket pointing to another socket ID (which may be actual or virtual)
    Virtual {
        target_socket_id: u64,
        user_prefix: UserPrefix,
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
    // Global key-value store accessible from all threads
    static ref KEY_VALUE_STORE: DashMap<Vec<u8>, Vec<u8>> = DashMap::new();
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
        drop(worker_ref); // Release the DashMap reference before the send

        channel.send(js_callback);
        true
    } else {
        false
    }
}


// Get sender and user prefix for a socket, following virtual socket chains.
// Returns owned values (Arc is cloned, UserPrefix is copied) so no lifetime issues.
fn get_socket(socket_id: u64) -> Option<(Arc<tokio::sync::Mutex<Sender>>, UserPrefix)> {
    let mut current_id = socket_id;
    let mut first_user_prefix = UserPrefix { len: 0, data: [0; 15] };

    for _ in 0..100 { // Prevent infinite loops from cycles (that should be impossible, but still..)
        if let Some(guard) = SOCKETS.get(&current_id) {
            match guard.value() {
                SocketEntry::Actual { sender_mutex } => {
                    // Found an actual socket - clone Arc and return
                    return Some((Arc::clone(sender_mutex), first_user_prefix));
                }
                SocketEntry::Virtual { target_socket_id, user_prefix } => {
                    // Store the first non-empty user prefix we encounter
                    if first_user_prefix.len == 0 && user_prefix.len > 0 {
                        first_user_prefix = user_prefix.clone();
                    }
                    current_id = *target_socket_id;
                    // Continue following the chain
                }
            }
        } else {
            return None;
        }
    }
    
    // Max depth exceeded
    eprintln!("Max virtual socket chain depth exceeded for socket_id={}", socket_id);
    None
}

// Helper function to send a close frame to a socket
async fn send_close_frame(socket_id: u64, reason: String) {
    if let Some((sender_mutex, _)) = get_socket(socket_id) {
        let mut sender = sender_mutex.lock().await;
        let _ = sender.send(Message::Close(Some(CloseFrame {
            code: CloseCode::Error,
            reason: reason.into(),
        }))).await;
    }
}

// Helper function to send a message to a single socket, handling user prefix attachment
async fn send_to_socket(socket_id: u64, message: &Message) -> bool {
    // Get sender and user prefix (already cloned/copied, no guards held)
    let (sender_mutex, user_prefix) = match get_socket(socket_id) {
        Some(result) => result,
        None => return false,
    };
    
    // Build the message to send
    let final_message = if user_prefix.len > 0 {
        // Always prefix the user data, regardless of message type
        let (original_data, is_text) = match message {
            Message::Text(text) => (text.as_bytes(), true),
            Message::Binary(data) => (data.as_slice(), false),
            other => {
                // Pass through other message types unchanged
                let mut sender = sender_mutex.lock().await;
                return match sender.send(other.clone()).await {
                    Ok(_) => true,
                    Err(e) => { println!("Send failed: {}", e); false }
                };
            }
        };
        
        // Create prefixed data
        let prefix_bytes = &user_prefix.data[..user_prefix.len as usize];
        let mut prefixed_data = Vec::with_capacity(prefix_bytes.len() + original_data.len());
        prefixed_data.extend_from_slice(prefix_bytes);
        prefixed_data.extend_from_slice(original_data);
        
        if is_text {
            // For text messages, assume the result is valid UTF-8 as specified
            Message::Text(String::from_utf8_lossy(&prefixed_data).into_owned())
        } else {
            Message::Binary(prefixed_data)
        }
    } else {
        message.clone()
    };
    
    let mut sender = sender_mutex.lock().await;
    if let Err(e) = sender.send(final_message).await {
        println!("Send failed: {}", e);
        false
    } else {
        true
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
    let mut channel = CHANNELS.entry(channel_name.to_vec()).or_default();
    
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
    let user_prefix_opt = read_optional_bytes(&mut cx, 1)?;
    
    let user_prefix = if let Some(prefix_data) = user_prefix_opt {
        if prefix_data.len() > 15 {
            return cx.throw_error("User prefix cannot exceed 15 bytes");
        }
        let mut prefix = UserPrefix {
            len: prefix_data.len() as u8,
            data: [0; 15],
        };
        prefix.data[..prefix_data.len()].copy_from_slice(&prefix_data);
        prefix
    } else {
        UserPrefix { len: 0, data: [0; 15] } // Empty prefix
    };
    
    let virtual_socket_id = SOCKET_COUNTER.fetch_add(1, Ordering::Relaxed);

    SOCKETS.insert(virtual_socket_id, SocketEntry::Virtual { target_socket_id, user_prefix });
    
    Ok(cx.number(virtual_socket_id as f64))
}

fn delete_virtual_socket(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let virtual_socket_id = read_arg!(&mut cx, 0, u64);
    let expected_target_socket_id: Option<u64> = read_arg_opt!(&mut cx, 1, u64);

    let opt_pair = SOCKETS.remove_if(&virtual_socket_id, |_key,val| match val {
        SocketEntry::Virtual { target_socket_id, .. } => expected_target_socket_id.is_none() || expected_target_socket_id == Some(*target_socket_id),
        SocketEntry::Actual { .. } => false,
    });

    Ok(cx.boolean(opt_pair.is_some()))
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

fn read_optional_bytes(cx: &mut FunctionContext, index: usize) -> NeonResult<Option<Vec<u8>>> {
    match cx.argument_opt(index) {
        Some(val) => {
            if val.downcast::<JsUndefined, _>(cx).is_ok() {
                Ok(None)
            } else {
                js_value_to_bytes(cx, val).map(Some)
            }
        }
        None => Ok(None),
    }
}

fn get_key(mut cx: FunctionContext) -> JsResult<JsValue> {
    let key = read_arg!(&mut cx, 0, Bytes);

    if let Some(value_ref) = KEY_VALUE_STORE.get(&key) {
        let buffer = create_js_buffer(&mut cx, value_ref.value())?;
        Ok(buffer.upcast())
    } else {
        Ok(cx.undefined().upcast())
    }
}

fn set_key(mut cx: FunctionContext) -> JsResult<JsValue> {
    let key = read_arg!(&mut cx, 0, Bytes);
    let value_opt = read_optional_bytes(&mut cx, 1)?;

    let old_value = match value_opt {
        Some(value) => {
            KEY_VALUE_STORE.insert(key, value)
        }
        None => {
            KEY_VALUE_STORE.remove(&key).map(|(_, v)| v)
        }
    };

    if let Some(old) = old_value {
        let buffer = create_js_buffer(&mut cx, &old)?;
        Ok(buffer.upcast())
    } else {
        Ok(cx.undefined().upcast())
    }

}

fn set_key_if(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let key = read_arg!(&mut cx, 0, Bytes);
    let new_value = read_optional_bytes(&mut cx, 1)?;
    let check_value = read_optional_bytes(&mut cx, 2)?;

    let updated = match KEY_VALUE_STORE.entry(key) {
        Entry::Occupied(mut entry) => {
            if let Some(check) = check_value.as_ref() {
                if entry.get().as_slice() == check.as_slice() {
                    match new_value.clone() {
                        Some(new_val) => {
                            entry.insert(new_val);
                        }
                        None => {
                            entry.remove();
                        }
                    }
                    true
                } else {
                    false
                }
            } else {
                false
            }
        }
        Entry::Vacant(entry) => {
            if check_value.is_none() {
                if let Some(new_val) = new_value {
                    entry.insert(new_val);
                }
                true
            } else {
                false
            }
        }
    };

    Ok(cx.boolean(updated))
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
    eprintln!("New connection from {:?}", stream.peer_addr());
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

    eprintln!("socket_id={} assign to worker_id={}", socket_id, worker_id);
    
    // Check for open_handler without holding the lock during accept
    let open_handler = WORKERS.get(&worker_id).and_then(|w| w.open_handler.clone());
    
    let ws_stream = if let Some(handler) = open_handler {
        // Capture headers during handshake for open_handler
        let mut headers_map = HashMap::new();
        let ws_stream = match accept_hdr_async(stream, |req: &Request, response: Response| {
            for (name, value) in req.headers() {
                if let Ok(value_str) = value.to_str() {
                    headers_map.insert(name.as_str().to_string(), value_str.to_string());
                }
            }
            Ok(response)
        }).await {
            Ok(ws) => ws,
            Err(e) => {
                if e.to_string() != "WebSocket protocol error: Handshake not finished" {
                    eprintln!("WebSocket connection failed: {}", e);
                }
                return;
            }
        };
        
        eprintln!("socket_id={} accepted=true", socket_id);
        
        // Call open_handler with captured headers
        let (tx, rx) = tokio::sync::oneshot::channel();
        let send_result = schedule_in_worker_main_thread(worker_id, move |mut cx| {
            let callback = handler.to_inner(&mut cx);
            let js_socket_id = cx.number(socket_id as f64);
            let js_client_ip = cx.string(peer_addr.map(|addr| addr.ip().to_string()).unwrap_or_default());
            
            let headers_obj = cx.empty_object();
            for (key, value) in headers_map {
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
                Some(value) => value.downcast::<JsBoolean, _>(&mut cx)
                    .map(|b| b.value(&mut cx)).unwrap_or(true),
                None => false,
            };

            let _ = tx.send(should_accept);
            Ok(())
        });
        
        let should_accept = send_result && 
            tokio::time::timeout(Duration::from_secs(5), rx).await
                .ok()
                .and_then(|r| r.ok())
                .unwrap_or(false);
        
        if !should_accept {
            eprintln!("socket_id={} rejected by open_handler", socket_id);
            return;
        }
        
        ws_stream
    } else {
        // No open_handler, just accept without capturing headers
        match tokio_tungstenite::accept_async(stream).await {
            Ok(ws) => {
                eprintln!("socket_id={} accepted=true", socket_id);
                ws
            }
            Err(e) => {
                if e.to_string() != "WebSocket protocol error: Handshake not finished" {
                    eprintln!("WebSocket connection failed: {}", e);
                }
                return;
            }
        }
    };
    
    let (ws_sender, mut ws_receiver) = ws_stream.split();
    
    // Store the WebSocket sender in global map
    SOCKETS.insert(socket_id, SocketEntry::Actual {
        sender_mutex: Arc::new(tokio::sync::Mutex::new(ws_sender)),
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
    SOCKETS.remove(&socket_id);

    // Call close handler
    if let Some(worker_ref) = WORKERS.get(&worker_id) {
        if let Some(handler) = &worker_ref.close_handler {
            let handler = Arc::clone(handler);
            
            schedule_in_worker_main_thread(worker_id, move |mut cx| {
                let callback = handler.to_inner(&mut cx);
                let js_socket_id = cx.number(socket_id as f64).upcast();
                invoke_js_callback(&mut cx, callback, vec![js_socket_id]);
                Ok(())
            });
        }
    }
}

async fn handle_socket_message(worker_id: u64, socket_id: u64, message: Message) -> bool {
    if let Some(worker_ref) = WORKERS.get(&worker_id) {
        let opt_handler = match &message {
            Message::Text(_) => &worker_ref.text_message_handler,
            Message::Binary(_) => &worker_ref.binary_message_handler,
            _ => &None
        };

        if let Some(handler) = opt_handler {
            let handler = Arc::clone(handler);
            
            let result = schedule_in_worker_main_thread(worker_id, move |mut cx| {
                let callback = handler.to_inner(&mut cx);
                
                let js_data = match message {
                    Message::Text(text) => cx.string(text).upcast::<JsValue>(),
                    Message::Binary(data) => create_js_buffer(&mut cx, &data)?.upcast::<JsValue>(),
                    _ => cx.undefined().upcast::<JsValue>(),
                };
                
                let js_socket_id = cx.number(socket_id as f64);
                
                invoke_js_callback(&mut cx, callback, vec![js_data, js_socket_id.upcast()]);
                
                Ok(())
            });
            
            if !result {
                send_close_frame(socket_id, "Server worker unavailable".to_string()).await;
                return false; // Signal that the connection should be terminated
            }
        }
        true // Continue processing messages
    } else {
        send_close_frame(socket_id, "Server worker is down".to_string()).await;
        false // Terminate connection if worker doesn't exist
    }
}

fn cleanup_disconnected_connections() {
    // Clean up virtual sockets that point to non-existent actual sockets
    // First collect the IDs to remove (can't call get_socket while retain holds locks)
    let mut virtual_sockets_to_check: Vec<(u64, u64)> = Vec::new();
    
    // Collect all virtual sockets
    for entry in SOCKETS.iter() {
        if let SocketEntry::Virtual { target_socket_id, .. } = entry.value() {
            virtual_sockets_to_check.push((*entry.key(), *target_socket_id));
        }
    }
    
    // Now check which ones are invalid (without holding any locks)
    let mut to_remove = Vec::new();
    for (virtual_id, target_id) in virtual_sockets_to_check {
        if get_socket(target_id).is_none() {
            to_remove.push(virtual_id);
        }
    }
    
    // Remove invalid virtual sockets
    for virtual_id in to_remove {
        SOCKETS.remove(&virtual_id);
    }

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
    cx.export_function("hasSubscriptions", has_subscription)?;
    cx.export_function("createVirtualSocket", create_virtual_socket)?;
    cx.export_function("deleteVirtualSocket", delete_virtual_socket)?;
    cx.export_function("getKey", get_key)?;
    cx.export_function("setKey", set_key)?;
    cx.export_function("setKeyIf", set_key_if)?;
    Ok(())
}

