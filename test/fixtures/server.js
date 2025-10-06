const { start } = require('warpsocket');

const port = process.env.PORT || '3010';
const workerPath = process.env.WORKER_PATH;
const threads = process.env.THREADS ? JSON.parse(process.env.THREADS) : undefined;
const workerArg = process.env.WORKER_ARG ? JSON.parse(process.env.WORKER_ARG) : undefined;

(async () => {
  try {
    await start({ bind: `127.0.0.1:${port}`, workerPath, threads, workerArg });
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
