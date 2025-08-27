import * as path from 'node:path';
import { start } from 'warpsocket';

// Usage: node dist/examples/performance/server/server.js --bind 0.0.0.0:3000 --threads <N>

function arg(name: string, def?: string) {
  const ix = process.argv.indexOf(`--${name}`);
  if (ix >= 0 && process.argv[ix + 1]) return process.argv[ix + 1];
  return process.env[name.toUpperCase()] || def;
}

(async () => {
  const bind = arg('bind', '0.0.0.0:3000')!;
  const threadsStr = arg('threads');
  const threads = threadsStr != null ? Number(threadsStr) : undefined;
  const [host,portStr] = bind.split(':');
  const port = parseInt(portStr);

  console.log(`[perf-server] starting warpsocket on ${bind} through :${port + 15} with threads=${threads ?? 'auto'}`);
  await start({
    bind,
    workerPath: path.resolve(__dirname, './worker.js'),
    threads,
  });
  // Bind to additional ports, to alleviate ephemeral port exhaustion on the client side
  for(let i=port+1; i<port+16; i++) {
    await start({bind: `0.0.0.0:${i}`});
  }
  console.log('[perf-server] started');
})();
