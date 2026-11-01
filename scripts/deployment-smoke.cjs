// Creates and removes one synthetic user ONLY in an isolated *_deploy_test database.
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const requireApp = createRequire(path.join(process.cwd(), 'package.json'));
const mongoose = requireApp('mongoose');
async function main() {
  if (!process.env.DATABASE_NAME?.endsWith('_deploy_test'))
    throw new Error('This smoke test requires an isolated *_deploy_test database');
  if (process.env.MOBILE_PHONE_AUTH_REQUIRED !== 'false')
    throw new Error('This password-mode smoke test requires MOBILE_PHONE_AUTH_REQUIRED=false on both the isolated test API and this command');
  const base = process.argv[2];
  if (!base || !base.endsWith('/api')) throw new Error('Provide the isolated API base ending in /api');
  const db = await mongoose.createConnection(process.env.DATABASE_URL, {
    dbName: process.env.DATABASE_NAME, autoIndex: false, serverSelectionTimeoutMS: 10000,
  }).asPromise();
  let fixture;
  try {
    const Users = db.model('DeploymentUsers', requireApp('./dist/src/common/schemas/users.schema').UsersSchema);
    const suffix = randomUUID().replace(/-/g, '');
    const password = `Synthetic${suffix}1`;
    const phone = `+120255501${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
    fixture = await Users.create({ username: `deployment-${suffix}@example.test`, password,
      displayname: `deployment_${suffix}`, roles: ['user'], isEmailVerified: true,
      phoneE164: phone, phoneVerifiedAt: new Date() });
    for (const [kind, identifier] of [['Email', fixture.username], ['Mobile', phone]]) {
      const response = await fetch(`${base}/auth/password/login`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Platform': 'mobile' },
        body: JSON.stringify({ identifier, password }), signal: AbortSignal.timeout(10000) });
      const body = await response.json();
      if (!response.ok || !body.data?.accessToken) throw new Error(`${kind} password login failed: HTTP ${response.status}`);
      const me = await fetch(`${base}/auth/me`, { headers: {
        Authorization: `Bearer ${body.data.accessToken}`, 'X-Client-Platform': 'mobile',
      }, signal: AbortSignal.timeout(10000) });
      const identity = await me.json();
      if (!me.ok || identity.data?._id !== String(fixture._id) || identity.data?.username !== fixture.username)
        throw new Error('Authenticated identity does not match the created fixture');
      console.log(`${kind}/password login and mobile session identity: OK`);
    }
  } finally {
    if (fixture) await db.db.collection('Users').deleteOne({ _id: fixture._id });
    await db.close();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
