# Backend - Dark Fantasy


## 🚀 Setup

Use Node.js 22 or newer. The backend uses AWS SDK for JavaScript v3 for S3, Rekognition and SES.

# Install Dependencies: 
- `npm install` or `npm i`


# Environment Setup:
- Set Up `.env` file


# Database Configuration : 
- **Local Database URL:** `mongodb://127.0.0.1:27017/darkfantasy` for a local MongoDB without authentication. Keep the credentials and `authSource` required by your database when authentication is enabled.
- **Live Database URL:** = `live_database_url` ( replace with your live database url )

Start MongoDB before the backend. If your database runs in Docker, Docker Desktop and the database container must both be running. A backend running directly on Windows needs the container's port published to localhost; a backend inside Docker uses the MongoDB service name.

Run `npm run db:check` to test the configured database with a five-second connection timeout. `ECONNREFUSED` on localhost port 27017 means MongoDB is not listening there. The AWS SDK warning is unrelated to this connection failure.

Blocking and moderation also require a MongoDB replica set with transactions and
change streams. A successful database ping alone does not verify this requirement.
With standalone MongoDB the backend exits during startup, and the Expo API proxy
returns HTTP 502 even for correct sign-in credentials.

The local Docker database has been configured as the single-node replica set
`rs0`, using its existing data volume. Keep the replica-set command and key file
when recreating the container. Windows backend connections use
`directConnection=true` in `DATABASE_URL` because the replica advertises the
Docker hostname `mongo-db:27017`. Docker clients on the same network can use that
hostname directly. Start the backend after MongoDB has elected its primary.


# Default server runs : 
- **Port:** `9000`
- **API Docs:** [http://localhost:9000/docs]


# Run Backend Server : 
- `npm run dev`


# API Documentation (Swagger):
- [http://localhost:9000/docs] ( Swagger UI )


# API Configuration
- **Public Site Domain:** = [http://13.126.173.69]


# server Be (BackEnd):
=> `git pull origin pm/be`
=> `npm run build` 
=> `pm2 restart backend`
=> `pm2 log backend`


# Note: 
=> Ensure `.env` variables are set correctly.
=> Restart the server after modifying environment variables

## Phone OTP sign-in (Twilio Verify)

The mobile app signs in with a phone number and SMS code only. The web app's
email/password login is unchanged. Code lives in `src/auth/otp/`.

### 1. Create the Verify Service

1. In the [Twilio Console](https://console.twilio.com), open **Verify → Services → Create new**.
   Name it (the name appears in the SMS), enable the **SMS** channel, and keep the code length at **6**.
2. Copy the Service SID (`VA…`). Copy the Account SID (`AC…`) and Auth Token from the console home page.
3. Recommended: under the service, turn on **Fraud Guard**, and under **Verify → Geo permissions**,
   allow only the countries you serve (for example India). This is the main SMS-pumping defence.

### 2. Environment

Set these in `.env` (see `.env.example`). They are backend-only and are never sent to clients or logged:

| Variable | Purpose |
| --- | --- |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` | Twilio credentials. While any is missing, the OTP endpoints return 503 `OTP_UNAVAILABLE`. |
| `OTP_DEFAULT_COUNTRY` | Country assumed for numbers without `+code` (default `IN`). |
| `OTP_RESEND_COOLDOWN_SECONDS` | Wait between sends to one number (default 30). |
| `OTP_SEND_PER_PHONE_10M` / `_DAY`, `OTP_SEND_PER_IP_10M` / `_DAY` | Send caps (defaults 3 / 10 per number, 10 / 50 per IP). |
| `OTP_VERIFY_PER_PHONE_10M`, `OTP_VERIFY_PER_IP_10M` | Code-check caps (defaults 10 / 30). Twilio also allows 5 checks per code. |
| `OTP_BOOTSTRAP_PER_IP_10M` | Password attempts on the one-time phone setup (default 10). |
| `TRUST_PROXY` | Proxy hops in front of the API (e.g. `1`). **Required behind a load balancer**, or every user shares the balancer's IP limit. |
| `MOBILE_OTP_ONLY_ROUTES` | `on` makes the vault API require a phone session. Leave `off` until app builds without phone sign-in are retired. |

### 3. Migration (run before enabling)

The change is additive: `Users` gains optional `phoneE164` (E.164, unique) and
`phoneVerifiedAt` fields. Existing users keep both unset, and the legacy
`phoneNumber` field is not read or changed. Indexes are operator-managed:

```bash
npm run otp:indexes -- --report   # counts only, writes nothing
npm run otp:indexes -- --apply    # unique partial index Users.phoneE164 + TTL index on OtpThrottle
```

`DATABASE_URL` and `DATABASE_NAME` must be set in the shell.

### Endpoints (all under `/api`)

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `POST /auth/otp/send` `{ phone, purpose?: "login" \| "signup" }` | none | Login: an SMS is sent only if the number belongs to an account, but the response is identical either way. |
| `POST /auth/otp/verify` `{ phone, code }` | none | Returns `{ user, accessToken }` like `/auth/login`. The token has `auth_method: "otp"`. |
| `POST /auth/otp/signup/verify` `{ phone, code }` | none | Returns a 30-minute `signupToken`. |
| `POST /auth/otp/signup` `{ signupToken, username, password, firstName, lastName, age, gender }` | none | Creates the account with the verified phone. |
| `POST /auth/phone/bootstrap` `{ username, password }` | none | Existing users without a phone: returns a 15-minute `bootstrapToken` that only works on the two routes below. |
| `POST /auth/phone/send` `{ phone }`, `POST /auth/phone/verify` `{ phone, code }` | session or bootstrap token | Adds or changes the phone after a fresh OTP. A bootstrap token ends with a phone session. |

Errors return `{ statusCode, error, message }`. `error` is stable: `PHONE_INVALID`, `PHONE_UNSUPPORTED`,
`OTP_INVALID`, `OTP_EXPIRED`, `OTP_COOLDOWN`, `OTP_RATE_LIMITED`, `OTP_SEND_LIMIT`, `OTP_CHECK_LIMIT`,
`PHONE_IN_USE`, `PHONE_ALREADY_LINKED`, `PHONE_LOGIN_REQUIRED`, `SIGNUP_SESSION_INVALID`, `OTP_UNAVAILABLE`.

### How "mobile = OTP only" is enforced

- The Expo app sends `X-Client-Platform: mobile` on every request. Browsers cannot send it, because CORS does not allow the header.
- With that header, `POST /auth/login` and `POST /auth/signup` return 403 `PHONE_LOGIN_REQUIRED`, and
  `JwtStrategy` rejects any token whose `auth_method` is not `otp`. Old password sessions are signed out.
- Signup and bootstrap tokens are signed with a key derived from `JWT_SECRET`. They are never valid as sessions, including on the chat socket.
- **Spoofing limit:** the header is a client claim. A modified client can omit it and use the web
  login, which is still allowed. What the server guarantees is that sessions used by the real app are OTP sessions,
  and that routes marked `OtpSessionGuard` (the vault, with `MOBILE_OTP_ONLY_ROUTES=on`) reject web sessions.
  Stronger binding needs app attestation (Play Integrity / App Attest).

### Manual test with a Twilio trial account

Trial accounts only send SMS to **Verified Caller IDs** (Console → Phone Numbers → Verified Caller IDs).
Add your own mobile number there first. Other numbers fail with Twilio error 21608, which the API reports as `PHONE_UNSUPPORTED`.

1. Set the three `TWILIO_*` variables, run `npm run otp:indexes -- --apply`, then `npm run dev`.
2. New signup: in the app, tap **Create an account**, enter the verified number, enter the SMS code, then fill in the profile.
   Without SES configured, email verification is skipped in development and you are signed in.
3. Existing user: tap **Set up phone sign-in** on the sign-in screen, enter the email and password once, then the number and code.
4. Sign out and sign in with the phone number and code only.
5. Negative checks: enter a wrong code (`OTP_INVALID`), resend within 30 seconds (`OTP_COOLDOWN`), and send 4 codes in 10 minutes (`OTP_SEND_LIMIT`).
   Run `curl -X POST <api>/auth/login -H 'X-Client-Platform: mobile' -H 'Content-Type: application/json' -d '{"username":"…","password":"…"}'` and expect 403.
6. From Swagger (`/docs`), `POST /auth/otp/send` with the same body works without the app.
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
