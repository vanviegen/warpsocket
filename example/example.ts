const wsbroker = require('../index.node');
const fs = require('fs');
const path = require('path');

// Create a worker for the multi-room chat server
const chatWorker = {
    handleHttpRequest(request: any) {
        console.log('HTTP Request:', request.method, request.path);
        
        // Serve the chat client HTML file
        if (request.path === '/' || request.path === '/index.html') {
            try {
                const htmlContent = fs.readFileSync(path.join(__dirname, 'chat-client.html'));
                return {
                    status: 200,
                    headers: { 'content-type': 'text/html' },
                    body: htmlContent
                };
            } catch (error) {
                return {
                    status: 404,
                    headers: { 'content-type': 'text/plain' },
                    body: 'Chat client not found'
                };
            }
        }
        
        // Serve CSS file
        if (request.path === '/style.css') {
            try {
                const cssContent = fs.readFileSync(path.join(__dirname, 'style.css'));
                return {
                    status: 200,
                    headers: { 'content-type': 'text/css' },
                    body: cssContent
                };
            } catch (error) {
                return {
                    status: 404,
                    headers: { 'content-type': 'text/plain' },
                    body: 'CSS file not found'
                };
            }
        }
        
        // Serve JavaScript file
        if (request.path === '/chat-client.js') {
            try {
                const jsContent = fs.readFileSync(path.join(__dirname, 'chat-client.js'));
                return {
                    status: 200,
                    headers: { 'content-type': 'application/javascript' },
                    body: jsContent
                };
            } catch (error) {
                return {
                    status: 404,
                    headers: { 'content-type': 'text/plain' },
                    body: 'JavaScript file not found'
                };
            }
        }
        
        return {
            status: 404,
            headers: { 'content-type': 'text/plain' },
            body: 'Not Found'
        };
    },
    
    handleSocketMessage(data: string | Uint8Array, socketId: number, token?: Uint8Array) {
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
    
    handleSocketClose(socketId: number, token?: Uint8Array) {
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
console.log('Multi-room chat server started on http://localhost:3000');    
