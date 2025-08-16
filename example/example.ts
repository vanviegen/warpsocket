const wsbroker = require('./index.node');

// Create a worker
const worker = {
    handleHttpRequest(request: any, response: any) {
        console.log('HTTP Request:', request.method, request.path);
        // Return a simple response
        return {
            status: 200,
            headers: { 'content-type': 'text/plain' },
            body: new Uint8Array(Buffer.from('Hello from worker!'))
        };
    },
    
    handleSocketMessage(data: { data: Uint8Array, socketId: number, token?: Uint8Array }) {
        const message = Buffer.from(data.data).toString();
        console.log('Socket message from', data.socketId, ':', message);
        
        // Echo the message back
        return [
            { type: 'respond' as const, data: new Uint8Array(Buffer.from('Echo: ' + message)) }
        ];
    },
    
    handleSocketClose(socketId: number) {
        console.log('Socket closed:', socketId);
    }
};

// Register the worker
wsbroker.registerWorkerThread(worker);

// Start the server
wsbroker.start({ bind: '0.0.0.0:3000' });
console.log('WebSocket broker started on port 3000');    
