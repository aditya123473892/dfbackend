# Dark Fantasy backend

NestJS API and Socket.IO backend. Frontend: https://github.com/aditya123473892/dffrontend

## Local setup

Use Node.js 18.18.1 (the version currently declared by this application).

```sh
npm ci
cp .env.example .env
```

Configure MongoDB connection details, a random JWT_SECRET and PASSWORD_ENCRYPTION_PRIVATE_KEY in .env. Generate the encryption key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep this key stable for existing encrypted records. Set AWS S3 and SES credentials for uploads and email.

```sh
npm run dev
```

API: http://localhost:9000/api. Swagger: http://localhost:9000/docs. The frontend origin defaults to http://localhost:3000 in the example.

## Build and checks

```sh
npx nest build
npm run start:prod
npm test -- --runInBand
```

The existing npm build script installs the Nest CLI globally; `npx nest build` uses the installed project CLI. Tests requiring a database need a configured MongoDB instance.

Database dumps, uploaded files, local secrets, installed packages and generated output are intentionally excluded. The import script requires a separately supplied private dump; no production data is bundled. See CHAT_MEDIA_SECURITY.md for current media behavior.

## Chat, groups and posts API notes

- `GET /api/chats/conversations` lists direct and group conversations with the
  last message and unread count, most recent first. `POST /api/chats/groups/:groupId/read`
  (or socket `markGroupAsRead`) moves the caller's group read cursor.
- Message sends (`POST /api/chats/messages`, socket `sendMessage`/`sendGroupMessage`),
  comments (`POST /api/posts/comment`) and group creation accept an optional
  `clientId` (8–64 of `A-Z a-z 0-9 _ -`). Retrying with the same key returns the
  stored record instead of creating a duplicate.
- Socket history (`getChatHistory`, `getGroupChatHistory`) accepts `limit`
  (max 100) and `before` (message id) for paging; without `limit` the full
  history is returned as before. Sockets join their groups' rooms on connect.
  Events: `typing` (`{ receiver | groupId, isTyping }`), `groupUpdated`,
  `groupRemoved`, `groupRead`.
- Any authenticated user can create a group and owns it. The owner manages
  members, details, the image and deletion; members can leave
  (`POST /api/groups/:groupId/leave`; an owner hands ownership to the
  longest-standing member). `DELETE /api/groups/:groupId` deletes the group and
  its messages.
- Likes are idempotent and return `{ liked, likeCount }`. `GET /api/posts/:postId/comments`
  pages comments (`limit`, `before`). Comment authors and post authors can
  delete comments. Feeds include `likedByMe`; media URLs are signed per request.

## Data migration before deploying this version

```sh
npm run db:repair-post-interactions -- --dry-run   # report only
npm run db:repair-post-interactions                 # remove duplicate likes, rebuild counts, create the unique like index
npm run db:normalize-chat-ids -- --dry-run          # optional: convert string ids in ChatMessages/Groups to ObjectIds
```

The unique like index cannot build while duplicate likes exist; run the repair
first. New indexes on ChatMessages, Comments, Posts, Groups and ChatReadCursors
are created by Mongoose at startup.

## Integration tests

`npm run test:integration` runs chat, group and post tests against an
in-memory MongoDB replica set (`mongodb-memory-server`, downloaded on first run).

`npm run test:smoke` (after `npx nest build`) boots the compiled API against an
in-memory MongoDB and checks auth, groups, realtime delivery, unread counts,
likes and comments over HTTP and Socket.IO.
