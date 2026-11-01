const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { spawn } = require('node:child_process');
const path = require('node:path');

// Optional persistence suites receive their own disposable replica set, never the application DB.
async function main() {
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve(__dirname, '../node_modules/jest/bin/jest.js'), '--runInBand', ...process.argv.slice(2)], {
        cwd: path.resolve(__dirname, '..'), stdio: 'inherit',
        env: { ...process.env, TEST_MONGO_URI: replica.getUri() },
      });
      child.once('error',reject); child.once('exit',code => resolve(code ?? 1));
    });
    process.exitCode = code;
  } finally { await replica.stop(); }
}
main().catch(() => { console.error('Persistence test environment failed to start.'); process.exitCode=1; });
