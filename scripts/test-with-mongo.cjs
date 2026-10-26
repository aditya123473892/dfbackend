// Disposable replica set only. Never reads the application's DATABASE_URL.
const { spawn } = require('node:child_process');
const { MongoMemoryReplSet } = require(
  process.argv[2] || 'mongodb-memory-server',
);
(async () => {
  const mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  try {
    const child = spawn(
      process.execPath,
      [
        require.resolve('jest/bin/jest'),
        '--runInBand',
        '--testTimeout=15000',
        ...process.argv.slice(3),
      ],
      {
        stdio: 'inherit',
        windowsHide: true,
        env: { ...process.env, TEST_MONGO_URI: mongo.getUri() },
      },
    );
    process.exitCode = await new Promise((resolve, reject) => {
      child.on('exit', (code) => resolve(code ?? 1));
      child.on('error', reject);
    });
  } finally {
    await mongo.stop();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
