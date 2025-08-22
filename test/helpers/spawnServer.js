const { spawn } = require('node:child_process');
const path = require('node:path');
const portfinder = require('portfinder');

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
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderrBuf = '';
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      if (chunk.toString().includes('READY')) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Server exited early with code ${code}${stderrBuf ? `\nStderr:\n${stderrBuf}` : ''}`));
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error(`Server start timeout${stderrBuf ? `\nStderr:\n${stderrBuf}` : ''}`));
    };
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      clearTimeout(t);
    };

    child.on('error', (e) => { cleanup(); reject(e); });
    child.on('exit', onExit);
    child.stdout.on('data', onData);
    const t = setTimeout(onTimeout, 15000);
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    kill: () => child.kill('SIGTERM'),
    child
  };
}

module.exports = { spawnServer };
