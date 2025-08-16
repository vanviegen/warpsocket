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
try {
    wsbroker.start({ bind: '0.0.0.0:3000' });
    console.log('WebSocket broker started on port 3000');
    
    // Test some functions
    setTimeout(() => {
        console.log('Testing broker functions...');
        
        // These would work once we have actual connections
        // wsbroker.send(1, new Uint8Array(Buffer.from('test message')));
        // wsbroker.subscribe(1, new Uint8Array(Buffer.from('test-channel')));
        
        console.log('Broker is running. Connect WebSocket clients to ws://localhost:3000');
    }, 100000);
    
} catch (error) {
    console.error('Failed to start broker:', error);
}
