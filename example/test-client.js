// Simple WebSocket client to test the broker
const ws = new WebSocket('ws://localhost:3000');

ws.onopen = () => {
    console.log('Connected to WebSocket broker');
    
    // Send a test message
    ws.send('Hello from client!');
    
    // Send a few more messages
    setTimeout(() => ws.send('Message 2'), 1000);
    setTimeout(() => ws.send('Message 3'), 2000);
    setTimeout(() => ws.close(), 3000);
};

ws.onmessage = (event) => {
    console.log('Received:', event.data);
};

ws.onclose = () => {
    console.log('Connection closed');
};

ws.onerror = (error) => {
    console.error('WebSocket error:', error);
};
