import * as warpws from 'warpws';
import http from 'http';
import path from 'path';
import sirv from 'sirv';

warpws.start({ bind: '0.0.0.0:8080', workerPath: path.join(__dirname, 'worker.js') });

// Start HTTP server for static files
const assets = sirv(path.join(__dirname, 'client'), {
    dev: true, // Enable dev mode for better error messages
    single: true // SPA mode - serve index.html for unmatched routes
});

const server = http.createServer(assets);
server.listen(3000, '0.0.0.0', () => {
    console.log('HTTP server started on http://localhost:3000');
});
