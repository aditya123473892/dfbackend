// End-to-end smoke test: real compiled Nest app + in-memory MongoDB, driven over HTTP and Socket.IO.
// Usage (after `npx nest build`): npm run test:smoke
// The Socket.IO client is loaded from the mobile app (parent folder) to avoid a
// backend dependency; pass another folder containing socket.io-client if needed.
const path = require('path');
const { spawn } = require('child_process');
const backend = path.resolve(process.argv[2]);
const req = (name) => require(require.resolve(name, { paths: [backend] }));
const { MongoMemoryReplSet } = req('mongodb-memory-server');
const { MongoClient, ObjectId } = req('mongodb');
const jwt = req('jsonwebtoken');
const { io } = require(require.resolve('socket.io-client', { paths: [path.resolve(process.argv[3])] }));

const PORT = 9555;
const SECRET = 'smoke-secret-0123456789';
const base = `http://127.0.0.1:${PORT}/api`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function http(method, url, token, body) {
  const response = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await response.json(); } catch {}
  return { status: response.status, json };
}

(async () => {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();
  const client = await MongoClient.connect(uri);
  const db = client.db('smoke');
  const mkUser = (name, roles = ['user']) => ({
    _id: new ObjectId(), username: `${name}@example.test`, password: 'x', displayname: name,
    firstName: name, lastName: 'Test', roles, loginCount: 0, loginAttempts: 0, isBlocked: false,
    blockedBy: 'open', status: 'open', canEditProfile: false, isEmailVerified: true,
    passwordResetToken: `reset-${name}`, verifyEmailToken: `verify-${name}`,
  });
  const [alice, bob, carol] = [mkUser('alice'), mkUser('bob'), mkUser('carol')];
  await db.collection('Users').insertMany([alice, bob, carol]);
  const token = (user) => jwt.sign({ sub: String(user._id), roles: user.roles }, SECRET, { expiresIn: '1h' });
  const [ta, tb, tc] = [alice, bob, carol].map(token);

  const server = spawn(process.execPath, ['-r', './dist/src/register-paths.js', 'dist/src/main'], {
    cwd: backend,
    env: {
      ...process.env, PORT: String(PORT), DATABASE_URL: uri, DATABASE_NAME: 'smoke', JWT_SECRET: SECRET,
      EXPIRES_IN: '1h', FRONTEND_ORIGIN: 'http://localhost:3000', PASSWORD_ENCRYPTION_PRIVATE_KEY: '0'.repeat(64),
      STRIPE_SECRET_KEY: 'sk_test_smoke', AWS_S3_REGION: 'us-east-1', AWS_DEFAULT_S3_BUCKET: 'smoke-bucket',
    },
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const started = Date.now();
  while (!/Services running at PORT/.test(log)) {
    if (Date.now() - started > 90000 || server.exitCode !== null) {
      console.log(log.slice(-3000));
      throw new Error('backend did not start');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  check('backend boots with all modules wired', true);

  try {
    // Auth: expired/invalid token is 401 (not 403).
    const bad = await http('GET', '/chats/conversations', 'not-a-token');
    check('invalid token -> 401', bad.status === 401, `got ${bad.status}`);

    // Privilege escalation through PATCH /users/me is blocked.
    const patch = await http('PATCH', '/users/me', ta, { bio: 'hello', roles: ['admin'], isBlocked: true });
    const stored = await db.collection('Users').findOne({ _id: alice._id });
    check('PATCH /users/me ignores roles/isBlocked', patch.status < 300 && stored.roles.join() === 'user' && stored.isBlocked === false && stored.bio === 'hello');

    // Secrets are not exposed.
    const other = await http('GET', `/users/${bob._id}`, ta);
    const leaked = JSON.stringify(other.json).match(/reset-bob|verify-bob|bob@example/);
    check('GET /users/:id hides tokens and email', other.status < 300 && !leaked);

    // Any user can create a group; idempotent with clientId.
    const body = { name: 'Smoke group', members: [String(bob._id)], clientId: 'smoke-group-1' };
    const [g1, g2] = await Promise.all([http('POST', '/groups/create-group', ta, body), http('POST', '/groups/create-group', ta, body)]);
    const groupId = g1.json?.data?._id;
    check('non-admin creates group (idempotent)', g1.status < 300 && groupId && g2.json?.data?._id === groupId && (await db.collection('Groups').countDocuments()) === 1, `status ${g1.status}`);

    // Realtime: bob's socket is subscribed to the group on connect and receives HTTP-sent group messages.
    const connect = (t) => new Promise((resolve, reject) => {
      const s = io(`http://127.0.0.1:${PORT}`, { auth: { token: t }, transports: ['websocket'], reconnection: false });
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
    const sb = await connect(tb);
    const sc = await connect(tc);
    await new Promise((r) => setTimeout(r, 300));
    const gotGroup = new Promise((resolve) => sb.on('receiveGroupMessage', resolve));
    const carolGot = [];
    sc.on('receiveGroupMessage', (m) => carolGot.push(m));
    const send = await http('POST', '/chats/messages', ta, { groupId, message: 'hi group', clientId: 'smoke-msg-1' });
    const retry = await http('POST', '/chats/messages', ta, { groupId, message: 'hi group', clientId: 'smoke-msg-1' });
    const delivered = await Promise.race([gotGroup, new Promise((r) => setTimeout(() => r(null), 3000))]);
    check('group message delivered live without joinGroup', delivered?.message === 'hi group');
    check('retried send returns the same message', send.json?.data?._id && send.json.data._id === retry.json?.data?._id);
    check('non-member receives nothing', carolGot.length === 0);

    // Typing relay in a group.
    const typing = new Promise((resolve) => sb.on('typing', resolve));
    const sa = await connect(ta);
    await new Promise((r) => setTimeout(r, 200));
    sa.emit('typing', { groupId, isTyping: true });
    const typed = await Promise.race([typing, new Promise((r) => setTimeout(() => r(null), 2000))]);
    check('group typing relayed', typed?.groupId === groupId && typed?.sender === String(alice._id));

    // Unread + read cursor.
    let conv = await http('GET', '/chats/conversations', tb);
    const groupConv = conv.json?.data?.conversations?.find((c) => c.id === `group:${groupId}`);
    check('conversation list has group unread=1 and preview', groupConv?.unreadCount === 1 && groupConv?.lastMessage?.message === 'hi group');
    const ack = await new Promise((resolve) => sb.emit('markGroupAsRead', { groupId }, resolve));
    conv = await http('GET', '/chats/conversations', tb);
    check('markGroupAsRead ack clears unread', ack?.groupId === groupId && conv.json.data.conversations.find((c) => c.id === `group:${groupId}`).unreadCount === 0);

    // Paged history over the socket.
    const history = await new Promise((resolve) => {
      sb.once('groupChatHistory', resolve);
      sb.emit('getGroupChatHistory', { groupId, limit: 10 });
    });
    check('paged group history', Array.isArray(history) && history.length === 1);

    // Removing a member detaches their socket immediately.
    const removed = new Promise((resolve) => sb.on('groupRemoved', resolve));
    await http('POST', '/groups/remove-members', ta, { groupId, members: [String(bob._id)] });
    const removedEvent = await Promise.race([removed, new Promise((r) => setTimeout(() => r(null), 2000))]);
    const afterRemoval = [];
    sb.on('receiveGroupMessage', (m) => afterRemoval.push(m));
    await http('POST', '/chats/messages', ta, { groupId, message: 'after removal' });
    await new Promise((r) => setTimeout(r, 500));
    check('removed member notified and stops receiving', removedEvent?.groupId === groupId && afterRemoval.length === 0);
    const forbidden = await http('GET', `/groups/${groupId}/members`, tb);
    check('removed member gets 403 on group details', forbidden.status === 403, `got ${forbidden.status}`);

    // Posts: like idempotency and visibility.
    const post = { _id: new ObjectId(), user: carol._id, caption: 'p', visibility: 'public', status: 'approved', media: [], likes: [], comments: [], createdAt: new Date(), updatedAt: new Date() };
    const pending = { ...post, _id: new ObjectId(), status: 'pending' };
    await db.collection('Posts').insertMany([post, pending]);
    const likes = await Promise.all(Array.from({ length: 5 }, () => http('POST', `/posts/${post._id}/like`, ta)));
    const count = await db.collection('Likes').countDocuments({ post: post._id });
    check('5 concurrent likes -> 1 like', likes.every((r) => r.status < 300) && count === 1 && likes.at(-1).json?.data?.likeCount === 1);
    const pendingLike = await http('POST', `/posts/${pending._id}/like`, ta);
    check('cannot like another user\'s pending post', pendingLike.status === 404, `got ${pendingLike.status}`);
    const comment = await http('POST', '/posts/comment', tb, { post: String(post._id), content: ' nice ', clientId: 'smoke-cmt-1' });
    const page = await http('GET', `/posts/${post._id}/comments?limit=5`, ta);
    check('comment created and listed', comment.json?.data?.content === 'nice' && page.json?.data?.comments?.length === 1);
    const delOther = await http('DELETE', `/posts/${post._id}/comment/${comment.json.data._id}`, ta);
    const delOwner = await http('DELETE', `/posts/${post._id}/comment/${comment.json.data._id}`, tc);
    check('only comment/post author can delete comment', delOther.status === 403 && delOwner.status < 300, `${delOther.status}/${delOwner.status}`);
    const feed = await http('GET', '/posts/public/feeds?limit=10&skip=0', ta);
    check('feed returns likedByMe', feed.json?.data?.posts?.[0]?.likedByMe === true);
    const delPost = await http('DELETE', `/posts/${post._id}`, ta);
    check('non-owner cannot delete post', delPost.status === 404 && (await db.collection('Posts').countDocuments({ _id: post._id })) === 1, `got ${delPost.status}`);

    sa.close(); sb.close(); sc.close();
  } finally {
    server.kill();
    await client.close();
    await replSet.stop();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
