import * as warpsocket from 'warpsocket';

const workerId = Math.random().toString(36).substring(2);
console.log(`Worker thread ${workerId} started`);

// In-memory store for user state (in a real app, use a database)
const userStates = new Map<number, { alias: string; room: string }>();

export function handleOpen(socketId: number, ip: string, headers: Record<string, string>) {
    console.log(`Socket ${socketId} opened from ${ip} in worker thread ${workerId}`, headers);
    return true; // Allow the connection
}

function send(socketOrChannel: number | string, message: any) {
    const data = JSON.stringify(message);
    warpsocket.send(socketOrChannel, data);
}

const messageHandlers: Record<string, (data: any, socketId: number, userInfo: any) => void> = {
    join: function({ alias, room }: any, socketId: number, userInfo: any) {
        // If user was in another room, unsubscribe from it and notify
        if (userInfo && userInfo.room && userInfo.room !== room) {
            warpsocket.unsubscribe(socketId, userInfo.room);
            
            // Notify old room that user left
            send(userInfo.room, {
                type: 'user-left',
                alias: userInfo.alias,
                timestamp: Date.now()
            });
        }
        
        // Store user state in memory
        userStates.set(socketId, { alias, room });
        
        // Subscribe to the new room
        warpsocket.subscribe(socketId, room);
        
        // Notify user they joined successfully
        send(socketId, {
            type: 'joined',
            room: room,
            alias: alias
        });

        // Notify room that user joined
        send(room, {
            type: 'user-joined',
            alias: alias,
            timestamp: Date.now()
        });

        console.log(`${alias} joined room ${room}`);
    },
    message: function({ body }: any, socketId: number, userInfo: any) {
        // User sending a message
        if (userInfo && userInfo.room) {
            send(userInfo.room, {
                type: 'chat-message',
                alias: userInfo.alias,
                body: body,
                timestamp: Date.now()
            });
            console.log(`${userInfo.alias} in ${userInfo.room}: ${body}`);
        } else {
            send(socketId, { type: 'error', body: 'You must join a room first' });
        }
    }
}

export function handleTextMessage(data: string, socketId: number) {
    const message = JSON.parse(data);
    console.log(`Socket ${socketId} message in worker thread ${workerId}:`, message);

    const userInfo = userStates.get(socketId);

    const handler = messageHandlers[message.type];
    if (handler) handler(message, socketId, userInfo);
    else console.warn('Unknown message type:', message.type);
}

export function handleClose(socketId: number) {
    console.log('Socket closed:', socketId);
    
    const userInfo = userStates.get(socketId);
    if (userInfo && userInfo.room) {
        // Notify room that user left
        send(userInfo.room, {
            type: 'user-left',
            alias: userInfo.alias,
            timestamp: Date.now()
        });
        console.log(`${userInfo.alias} left room ${userInfo.room}`);
    }
    
    // Clean up user state
    userStates.delete(socketId);
    
    // Note: WarpSocket automatically handles unsubscribing closed connections from all channels
}
