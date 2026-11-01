# Deploy the backend and connect the app

This deploys the canonical NestJS backend in this repository. It does not deploy the older `backenddf` copy or a Next.js project. One API instance is supported by this configuration; use a shared Socket.IO adapter and distributed presence before scaling horizontally.

## Required services

- A Linux Docker host (Node 22 for a non-Docker deployment), a DNS hostname, and ports 80/443 available for Caddy TLS.
- MongoDB Atlas or another authenticated **replica set**, reachable from the host. Standalone MongoDB cannot support blocking, change streams and transactions. For Docker, `localhost` is the container itself; use the managed database URI or a resolvable database service hostname.
- A private S3 bucket with encryption, BucketOwnerEnforced, all public-access blocking enabled, `temp/` expiry after one day, and incomplete multipart upload abort after one day. Configure Rekognition in the bucket region. The infrastructure template in the mobile repository includes the object prefixes this API uses.
- Twilio Verify SMS credentials and an SES verified sender/domain. Trial SMS and SES sandbox restrictions must be cleared for the intended recipients. No delivery mocks are allowed in production signup.
- A web frontend at `PUBLIC_SITE_DOMAIN` handling the existing `/reset-password?token=...` flow. Signup email verification itself is handled by this API and works from a phone browser.
- Optional: a DeepSeek API key for Chat with God. Without it, AI replies are unavailable; it is never placed in the mobile environment.

## Configuration

Copy `.env.production.example` to `.env.production` and fill every blank required value. Keep the file out of Git and restrict filesystem access. Generate `JWT_SECRET` from at least 32 random bytes and `PASSWORD_ENCRYPTION_PRIVATE_KEY` from exactly 32 random bytes encoded as 64 hex characters. Preserve them between restarts; rotating them invalidates sessions or existing encrypted links.

`PUBLIC_API_URL` is the HTTPS **origin**, for example `https://api.example.com`, with no `/api` suffix. `PUBLIC_SITE_DOMAIN` is the website origin. In contrast, the mobile `EXPO_PUBLIC_API_URL` **includes `/api`**. Set `API_DOMAIN` to the same API hostname without a scheme and `ACME_EMAIL` for certificate renewal.

Prefer an EC2/ECS IAM role or workload identity for AWS. On hosts without a role, supply `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` together via the host's secret store; include `AWS_SESSION_TOKEN` for temporary credentials. The deployment templates do not contain real credentials.

For a single Caddy proxy, `TRUST_PROXY=1`. Change this to the exact hop count only when your network topology changes, and ensure the application port is not directly internet-accessible. Do not set Express trust proxy to `true`.

`FRONTEND_ORIGIN` is a comma-separated exact allowlist for browsers. Native Expo requests do not send an Origin and do not require wildcard CORS. REST allows the mobile client header; Socket.IO uses the same configured browser origins. Swagger is disabled in production unless `SWAGGER_ENABLED=true` is deliberately set.

## Build, migrate, start

### Render with the Atlas cluster

Use the canonical `dfbackend` repository (or `dfbackend` as Root Directory in the combined workspace). Set the service's production environment values from `.env.production.example`; `deploy/render.env.example` contains the Atlas overlay for `cluster0.by1ww6f.mongodb.net` and database `darkfantasy`.

In Render's **Environment** page, set `DATABASE_URL` with the real Atlas database-user password replacing `<db_password>`. URL-encode password characters such as `@`, `:`, `/` and `#`. Keep `DATABASE_NAME=darkfantasy`, `NODE_ENV=production`, and `HOST=0.0.0.0`; allow Render to provide `PORT`. Do not commit the completed URI or put it in the mobile app.

For a native Node service, use build command `npm ci --include=dev && npm run build`, start command `npm run start:prod`, and health check path `/api/health/ready`. Run `npm run migrate:deploy` before the first production start (a pre-deploy command when your Render plan supports it, otherwise an operator migration job with the same environment). The existing Dockerfile also supports Render's Docker runtime.

In Render's **Connect > Outbound** tab, copy the service's outbound IP ranges into Atlas **Network Access**. Supply the other production secrets required by `.env.production.example` too; setting MongoDB alone does not configure SMS, email, storage, or the app's public URL. After deployment, point the mobile app's `EXPO_PUBLIC_API_URL` at the Render HTTPS origin plus `/api` and rebuild.

References: [Render environment variables](https://render.com/docs/configure-environment-variables), [Render outbound addresses](https://render.com/docs/outbound-ip-addresses), [Atlas connection troubleshooting](https://www.mongodb.com/docs/atlas/troubleshoot-connection/).

Run from the backend directory:

```sh
docker compose --env-file .env.production -f deploy/compose.production.yml build
docker compose --env-file .env.production -f deploy/compose.production.yml run --rm --no-deps backend npm run migrate:deploy
docker compose --env-file .env.production -f deploy/compose.production.yml up -d
docker compose --env-file .env.production -f deploy/compose.production.yml ps
```

The migration creates declared schema indexes plus phone, storage, blocking and reporting indexes. It never drops collections or deletes/merges user data. Run it with an operator database principal allowed to create indexes. It fails on conflicting indexes or incompatible duplicate data; resolve those deliberately, then rerun. Do not remove live indexes to make deployment pass without understanding the violated invariant.

The API refuses production startup if required unique indexes are absent. Migrations run separately from API traffic. On a hosted container platform, run the same image with command `npm run migrate:deploy` as a release/predeploy job, then use its default command for the web service. Set the platform's injected `PORT` and leave `HOST=0.0.0.0`. If the platform supplies TLS, omit Caddy and configure its proxy hop count appropriately.

The runtime image contains production dependencies, compiled code and email templates, runs as the `node` user, and has no baked-in `.env`, database dump or cloud credentials. Build tools and test dependencies stay in the build stage. Rebuild the image for code changes; do not copy Windows `node_modules` into Linux.

JWT expiry defaults to `7d` when `EXPIRES_IN` is omitted; supported explicit values include `15m`, `1h` and `7d`. Invalid duration strings are rejected at startup rather than breaking login later.

## Health and app contract

- `GET /api/health/live`: process liveness.
- `GET /api/health/ready`: database connectivity, returns HTTP 503 on failure. Does not claim Twilio, SES, S3 or AI delivery is healthy.
- REST base: `https://api.example.com/api`.
- Socket.IO: `https://api.example.com`, default `/socket.io` path. The reverse proxy must support polling and WebSocket upgrade. Caddy handles upgrades automatically.

From the **mobile repository**, run:

```sh
node scripts/check-deployment.cjs https://api.example.com/api
```

This checks readiness, the mobile auth route's validation contract and the Socket.IO transport handshake without creating an account or sending an SMS. For web previews, set `APP_ORIGIN` to a configured origin to check CORS preflight too. `--local` permits loopback HTTP for an isolated deployment test.

For a disposable replica-set database whose name ends in `_deploy_test`, `scripts/deployment-smoke.cjs <API-base>` can additionally create one synthetic account, exercise email/password and mobile/password login, verify `/auth/me`, and remove only its own fixture. Run it from the compiled backend directory with that isolated database's environment and `MOBILE_PHONE_AUTH_REQUIRED=false` on both the test API and the command. This password-mode check does not validate production phone OTP delivery. It refuses ordinary database names and never sends SMS or email; do not point it at production.

Copy the mobile `.env.mobile.production.example` public values into `.env.mobile` or the EAS build environment. Set `EXPO_PUBLIC_API_URL=https://api.example.com/api`, disable **both** development proxy flags, and rebuild the release app. Never put database/AWS/SES/Twilio/AI secrets in `EXPO_PUBLIC_*`. The release config rejects HTTP. Expo Go on a phone can use the hosted HTTPS API while Metro still serves the app locally.

## Signup, verification and login

1. `POST /api/auth/otp/send` with `{ phone, purpose: "signup" }`.
2. `POST /api/auth/otp/signup/verify` with `{ phone, code }` returns a short-lived `signupToken`.
3. `POST /api/auth/otp/signup` with `{ signupToken, username, password }`; `username` is email. Production returns `emailVerificationRequired: true`.
4. The email includes `/api/auth/email/verify?token=...`. The derived signing key and scope make this token unusable as an app session. It expires after 24 hours; the link only verifies the same account/email. Return to the app after verification.
5. With `MOBILE_PHONE_AUTH_REQUIRED=true` (the production default), mobile clients sign in through the phone OTP endpoints. When this setting is false, `POST /api/auth/password/login` accepts `{ identifier, password }` (email or verified mobile). Set the mobile `EXPO_PUBLIC_PHONE_AUTH_REQUIRED` flag to the matching mode and rebuild. The mobile service confirms the issued identity against `/auth/me` before persisting the session.
6. Resend from the app's password sign-in form: enter email/password, then choose **Resend verification email**. `/api/auth/email/resend` authenticates the password and limits attempts. It does not return the verification token.

Provider failure can occur after the account has been created. In that case, use resend rather than creating another account. Production startup requires delivery configuration, but only a staging send verifies the provider credentials and recipient restrictions. Existing unverified accounts from the old admin-review flow need explicit account policy/migration; the legacy endpoint does not silently approve them.

## Deleted vault retention

Deleting an approved vault image/video creates a tombstone immediately, hides the item in the app and denies new download URLs. After outstanding upload/processing leases expire, the cleanup worker copies approved originals to:

```text
deleted/vault/<owner>/<vault-item-id>/<source-key-hash>.jpg
```

Videos retain their `.mp4`/`.mov` extension. These keys use `PHOTO_PRIVATE_BUCKET` when configured, otherwise the private fallback bucket. Copy source ETag is pinned; the copy is checked before originals are removed. Deterministic keys and metadata make retries idempotent. A failed archive leaves the source and hidden deletion row intact for the next scheduled attempt. The unused-object worker must not delete a source while archival is pending.

App endpoints do not list archives or generate signed archive URLs. They are not a user-accessible recycle bin. Existing signed URLs to the **original** may remain usable until their expiry or source cleanup; deleting a UI entry cannot revoke an already issued URL instantly. Gallery exports remain independent copies.

The backend role needs `GetObject` on sources, `PutObject`/`GetObject` on `deleted/vault/*`, and source delete/version-list permissions. Keep archives outside public CDN origins and public policies. Do not configure a bucket-wide current-object expiry rule that removes archives. Define a retention/lifecycle policy with the product owner; there is no automatic deleted-archive expiry in this implementation. Full account purge includes the owner's archive prefix; ordinary item deletion retains it.

## Before switching real users

Verify on a staging environment: real SMS, signup/email click/resend, both login methods, password-reset website, image/video upload and moderation, vault restore/export and S3 archive retries, two-user direct/group chat, account deletion, backup restore and TLS renewal. The automated suite uses provider mocks and does not prove live delivery.

The earlier audit's dependency advisories, refresh-token/revocation work, disabled paid entitlement provider, and broader device/scale tests remain separate release-hardening work. A successful container build and health check are not a claim that all those findings are fixed. Do not scale the current single-instance gateway behind multiple replicas without the shared adapter work.

For rollback, keep the previous image and stable secrets, back up MongoDB before deployment, and inspect schema/index compatibility. These migrations are additive but unique indexes can expose existing bad data. Observe readiness, application error rates, deletion retries and provider failures before directing app traffic to a new revision.
