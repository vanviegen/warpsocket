const wsbroker = require('../index.node');

// Create a worker for the multi-room chat server
const chatWorker = {
    handleMessage(data: string | Uint8Array, socketId: number, token?: Uint8Array) {
        try {
            const message = JSON.parse(Buffer.from(data).toString());
            console.log('Socket message from', socketId, ':', message);
            
            // Parse existing user info from token if available
            let userInfo = null;
            if (token) {
                try {
                    userInfo = JSON.parse(Buffer.from(token).toString());
                } catch (e) {
                    console.error('Error parsing token:', e);
                }
            }
            
            switch (message.type) {
                case 'join':
                    // User joining a room
                    const { alias, room } = message;
                    
                    // If user was in another room, unsubscribe from it and notify
                    if (userInfo && userInfo.room && userInfo.room !== room) {
                        wsbroker.unsubscribe(socketId, userInfo.room);
                        
                        // Notify old room that user left
                        wsbroker.sendToChannel(userInfo.room, JSON.stringify({
                            type: 'user-left',
                            alias: userInfo.alias,
                            timestamp: Date.now()
                        }));
                    }
                    
                    // Store user info in token
                    const newUserInfo = { alias, room };
                    wsbroker.setToken(socketId, JSON.stringify(newUserInfo));
                    
                    // Subscribe to the new room
                    wsbroker.subscribe(socketId, room);
                    
                    // Notify user they joined successfully
                    wsbroker.send(socketId, JSON.stringify({
                        type: 'joined',
                        room: room,
                        alias: alias
                    }));
                    
                    // Notify room that user joined
                    wsbroker.sendToChannel(room, JSON.stringify({
                        type: 'user-joined',
                        alias: alias,
                        timestamp: Date.now()
                    }));
                    
                    console.log(`${alias} joined room ${room}`);
                    break;
                    
                case 'message':
                    // User sending a message
                    if (userInfo && userInfo.room) {
                        wsbroker.sendToChannel(userInfo.room, JSON.stringify({
                            type: 'chat-message',
                            alias: userInfo.alias,
                            message: message.message,
                            timestamp: Date.now()
                        }));
                        console.log(`${userInfo.alias} in ${userInfo.room}: ${message.message}`);
                    } else {
                        // User not in a room
                        wsbroker.send(socketId, JSON.stringify({
                            type: 'error',
                            message: 'You must join a room first'
                        }));
                    }
                    break;
                    
                default:
                    console.log('Unknown message type:', message.type);
            }
        } catch (error) {
            console.error('Error handling socket message:', error);
            wsbroker.send(socketId, JSON.stringify({
                type: 'error',
                message: 'Invalid message format'
            }));
        }
    },
    
    handleClose(socketId: number, token?: Uint8Array) {
        console.log('Socket closed:', socketId);
        
        // Parse user info from token if available
        if (token) {
            try {
                const userInfo = JSON.parse(Buffer.from(token).toString());
                if (userInfo && userInfo.room && userInfo.alias) {
                    // Notify room that user left
                    wsbroker.sendToChannel(userInfo.room, JSON.stringify({
                        type: 'user-left',
                        alias: userInfo.alias,
                        timestamp: Date.now()
                    }));
                    console.log(`${userInfo.alias} left room ${userInfo.room}`);
                }
            } catch (error) {
                console.error('Error parsing token on close:', error);
            }
        }
        
        // Note: WSBroker automatically handles unsubscribing closed connections from all channels
    }
};

// Register the worker
wsbroker.registerWorkerThread(chatWorker);

// Start the server
wsbroker.start({ bind: '0.0.0.0:3000' });
console.log('WebSocket chat server started on ws://localhost:3000');
console.log('Connect using a WebSocket client to test the multi-room chat functionality.');    
