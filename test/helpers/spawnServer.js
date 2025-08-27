const { spawn } = require('node:child_process');
const path = require('node:path');
const portfinder = require('portfinder');
const net = require('node:net');

async function spawnServer(opts = {}) {
  const port = await portfinder.getPortPromise();

  const serverPath = path.resolve('test/fixtures/server.js');

  const child = spawn(process.execPath, [serverPath], {
    env: {
        ...process.env,
        PORT: String(port),
        WORKER_PATH: opts.workerPath || path.resolve('test/fixtures/test-worker.js'),
        THREADS: "threads" in opts ? JSON.stringify(opts.threads) : "0",
        RUST_LOG: process.env.RUST_LOG || 'warn'
    },
    stdio: ['ignore', 'inherit', 'inherit']
  });

  await new Promise((resolve, reject) => {
    const maxAttempts = 300; // 300 attempts * 50ms = 15 seconds max
    let attempts = 0;
    
    const tryConnect = () => {
      attempts++;
      
      const socket = new net.Socket();
      
      socket.on('connect', () => {
        socket.destroy();
        cleanup();
        resolve();
      });
      
      socket.on('error', () => {
        socket.destroy();
        if (attempts >= maxAttempts) {
          cleanup();
          reject(new Error(`Server start timeout after ${maxAttempts} attempts`));
        } else {
          setTimeout(tryConnect, 50);
        }
      });
      
      socket.connect(port, '127.0.0.1');
    };
    
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Server exited early with code ${code}`));
    };
    
    const cleanup = () => {
      child.off('exit', onExit);
    };

    child.on('error', (e) => { cleanup(); reject(e); });
    child.on('exit', onExit);
    
    // Start trying to connect
    setTimeout(tryConnect, 100); // Give the server a moment to start
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    kill: () => child.kill('SIGTERM'),
    child
  };
}

module.exports = { spawnServer };
