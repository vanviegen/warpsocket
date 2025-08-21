const wsbroker = require('../index.node');
const http = require('http');
const fs = require('fs');
const path = require('path');

import { IncomingMessage, ServerResponse } from 'http';

// Create a worker for the multi-room chat server
const chatWorker = {
    handleOpen(socketId: number, ip: string, headers: Record<string, string>) {
        console.log(`Socket ${socketId} opened from ${ip}`, headers);
        return true; // Allow the connection
    },
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
wsbroker.start({ bind: '0.0.0.0:8080' });
console.log('WebSocket server started on ws://localhost:8080');

// Start HTTP server for static files
const clientDir = path.join(__dirname, 'client');

const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let filePath = path.join(clientDir, req.url === '/' ? 'index.html' : req.url || '');
    
    // Prevent directory traversal
    if (!filePath.startsWith(clientDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    
    fs.readFile(filePath, (err: NodeJS.ErrnoException | null, data: Buffer) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('Not found');
            } else {
                res.writeHead(500);
                res.end('Server error');
            }
            return;
        }
        
        // Set content type based on file extension
        const ext = path.extname(filePath).toLowerCase();
        const contentTypes: { [key: string]: string } = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.json': 'application/json'
        };
        
        const contentType = contentTypes[ext] || 'text/plain';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

server.listen(3000, '0.0.0.0', () => {
    console.log('HTTP server started on http://localhost:3000');
});    
