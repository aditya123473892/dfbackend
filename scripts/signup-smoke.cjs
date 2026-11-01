// Real HTTP + Mongoose regression check in an isolated local database.
// No SMS/email is sent. Never uses the application's database or Atlas.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
require('dotenv').config({ path: path.join(__dirname, '../.env.development'), quiet: true });
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.DATABASE_URL || '';
  if (!/^mongodb:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/])/i.test(uri))
    throw new Error('Signup smoke test requires a loopback MongoDB server');
  const id = randomUUID().replace(/-/g, '');
  const database = `signup_${id}_deploy_test`;
  const email = `signup-${id}@example.test`;
  const password = `Smoke${id}A1`;
  const db = await mongoose.createConnection(uri, { dbName: database, autoIndex: false, serverSelectionTimeoutMS: 5000 }).asPromise();
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  let server;
  let exited;
  let fixture;
  try {
    // Reproduce the stuck content lock without touching the real lock or its holder.
    await db.db.collection('ReportCoordination').insertOne({ _id: 'sources', token: id,
      leaseUntil: new Date(0), startedAt: new Date(0), pid: -1 });
    await db.db.collection('Users').createIndex({ username: 1 }, { unique: true });
    await db.db.collection('Users').createIndex({ displayname: 1 }, { unique: true });
    server = spawn(process.execPath, ['-r', './dist/src/register-paths.js', 'dist/src/main.js'], {
      cwd: path.join(__dirname, '..'), windowsHide: true, stdio: 'ignore',
      env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port),
        DATABASE_NAME: database, MOBILE_PHONE_AUTH_REQUIRED: 'false', AWS_SES_REGION: '', AWS_MAIL_FROM: '' },
    });
    exited = once(server, 'exit');
    const base = `http://127.0.0.1:${port}/api`;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (server.exitCode !== null) throw new Error('Isolated backend exited during startup');
      try { ready = (await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('Isolated backend did not become ready');
    const post = async (route, payload) => {
      const response = await fetch(`${base}${route}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Platform': 'mobile' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
      return { status: response.status, body: await response.json() };
    };
    const profile = { username: email, password, firstName: 'Signup', lastName: 'Check',
      age: 28, gender: 'Prefer not to say', phoneNumber: '+919876543210' };
    const created = await post('/auth/signup', profile);
    fixture = await db.db.collection('Users').findOne({ username: email });
    if (created.status !== 201 || created.body.data?.emailVerificationRequired !== false ||
        !fixture?.isEmailVerified || fixture.phoneVerifiedAt || fixture.phoneE164)
      throw new Error(`Signup with a stuck content lock failed: HTTP ${created.status}`);
    console.log('Real signup with a stuck preservation lock: OK');
    // Simulate the partially saved account left by the former implementation.
    await db.db.collection('Users').updateOne({ _id: fixture._id, username: email }, { $set: { isEmailVerified: false } });
    const retried = await post('/auth/signup', profile);
    if (retried.status !== 201 || retried.body.data?.emailVerificationRequired !== false ||
        await db.db.collection('Users').countDocuments({ username: email }) !== 1)
      throw new Error(`Incomplete signup retry failed: HTTP ${retried.status}`);
    console.log('Retry finishes the original account without a duplicate: OK');
    const login = await post('/auth/password/login', { identifier: email, password });
    if (login.status !== 201 || !login.body.data?.accessToken)
      throw new Error(`Email/password login failed: HTTP ${login.status}`);
    const me = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${login.body.data.accessToken}`,
      'X-Client-Platform': 'mobile' }, signal: AbortSignal.timeout(10000) });
    const identity = await me.json();
    if (!me.ok || identity.data?._id !== String(fixture._id)) throw new Error('Authenticated identity check failed');
    console.log('Email/password login and authenticated identity: OK');
  } finally {
    if (server && server.exitCode === null) { server.kill(); await exited; }
    // Only this run's exact synthetic user and simulated lock are removed.
    if (fixture) await db.db.collection('Users').deleteOne({ _id: fixture._id, username: email });
    await db.db.collection('ReportCoordination').deleteOne({ _id: 'sources', token: id });
    await db.close();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
