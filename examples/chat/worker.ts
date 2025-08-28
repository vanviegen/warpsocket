import * as warpsocket from 'warpsocket';

const workerId = Math.random().toString(36).substring(2);
console.log(`Worker thread ${workerId} started`);

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
        
        // We're storing the user state (alias and room) in the token here
        // For a real app, you'd probably want to store this in a database, and just store a user/client ID in the token
        warpsocket.setToken(socketId, JSON.stringify({ alias, room }));
        
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

export function handleTextMessage(data: string, socketId: number, token?: Uint8Array) {
    const message = JSON.parse(data);
    console.log(`Socket ${socketId} message in worker thread ${workerId}:`, message);

    let userInfo = token ? JSON.parse(token.toString()) : undefined;

    const handler = messageHandlers[message.type];
    if (handler) handler(message, socketId, userInfo);
    else console.warn('Unknown message type:', message.type);
}

export function handleClose(socketId: number, token?: Uint8Array) {
    console.log('Socket closed:', socketId);
    
    // Parse user info from token if available
    if (token) {
        const userInfo = JSON.parse(Buffer.from(token).toString());
        if (userInfo && userInfo.room) {
            // Notify room that user left
            send(userInfo.room, {
                type: 'user-left',
                alias: userInfo.alias,
                timestamp: Date.now()
            });
            console.log(`${userInfo.alias} left room ${userInfo.room}`);
        }
    }
    
    // Note: WarpSocket automatically handles unsubscribing closed connections from all channels
}
