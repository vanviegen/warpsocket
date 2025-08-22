const { start } = require('wsbroker');

const port = process.env.PORT || '3010';
const workerPath = process.env.WORKER_PATH;
const threads = process.env.THREADS ? JSON.parse(process.env.THREADS) : undefined;

(async () => {
  try {
    await start({ bind: `127.0.0.1:${port}`, workerPath, threads });
    console.log('READY');
  } catch (err) {
    console.error('Server failed to start:', err && err.stack || err);
    process.exit(1);
  }

  process.on('SIGTERM', () => process.exit(0));

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection in server:', reason && reason.stack || reason);
    process.exit(1);
  });
})();
