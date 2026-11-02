// Local development database: `npm run db:local`, then Ctrl+C to stop.
// Runs the MongoDB build cached for the test suite as a one-node replica set (the API
// needs transactions), on 127.0.0.1:27017 with data kept in .local-mongo/. Never used in
// production, and never reads the application's DATABASE_URL.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { MongoBinary } = require('mongodb-memory-server-core');
const { MongoClient } = require('mongodb');

const PORT = 27017;
const HOST = '127.0.0.1';
const DATA = path.resolve(__dirname, '..', '.local-mongo');

async function initiate() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const client = new MongoClient(`mongodb://${HOST}:${PORT}/?directConnection=true`, {
      serverSelectionTimeoutMS: 1000,
    });
    try {
      await client.connect();
      const admin = client.db('admin');
      try {
        await admin.command({ replSetGetStatus: 1 });
      } catch {
        await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `${HOST}:${PORT}` }] } });
        console.log('Initialised replica set rs0.');
      }
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } finally {
      await client.close().catch(() => undefined);
    }
  }
  throw new Error('MongoDB did not start within a minute.');
}

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  const binary = await MongoBinary.getPath();
  const mongod = spawn(
    binary,
    ['--replSet', 'rs0', '--dbpath', DATA, '--port', String(PORT), '--bind_ip', HOST, '--quiet'],
    { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true },
  );
  mongod.on('exit', (code) => {
    console.log(`MongoDB stopped (exit code ${code}).`);
    process.exit(code ?? 0);
  });
  const stop = () => mongod.kill();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await initiate();
  console.log(`Local MongoDB ready on mongodb://${HOST}:${PORT}/ (data in .local-mongo). Ctrl+C to stop.`);
})().catch((error) => {
  console.error(`Local MongoDB failed: ${error.message}`);
  process.exitCode = 1;
});
