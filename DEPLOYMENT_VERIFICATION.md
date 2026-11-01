# Deployment verification — 2026-11-01

Validated locally. No cloud deployment or DNS change was performed. Container migration, outage and password-session checks below predate the later phone-only production-mode switch; the signup lock recovery was subsequently verified against an isolated real MongoDB database with `scripts/signup-smoke.cjs`.

| Check | Result |
| --- | --- |
| Backend regression tests | 44 suites passed, 6 skipped; 357 tests passed, 179 skipped; no failures |
| Mobile regression tests | 129 tests passed |
| Mobile TypeScript and ESLint | Passed |
| Android Metro bundle | Built successfully |
| Linux production Docker build | Passed; image `darkfantasy-backend:deploy-check` |
| Runtime contents | Runs as UID 1000; compiled email templates present; no baked-in `.env` or TypeScript development package |
| Compose and Caddy configuration | Validated using synthetic environment values; no public certificate requested |
| Migration on isolated MongoDB replica set | Passed initial migration and repeat execution, including legacy block-index compatibility |
| Production API contract | Liveness, readiness, validation, mobile request header, browser CORS and Socket.IO polling handshake passed |
| Password authentication against real MongoDB | Synthetic account email/password and phone/password login, then `/auth/me`, passed |
| Database failure and recovery | Liveness stayed HTTP 200; readiness returned HTTP 503 during outage and recovered after MongoDB restart |
| Production API documentation | `/docs` disabled by default, returned HTTP 404 |
| Restored local backend | `/api/health/ready` and app integration smoke script passed on port 9000 |

The production container tests used a disposable replica-set database and synthetic credentials. The authentication fixture was removed after testing. The temporary API/database containers and their dedicated network were removed after verification; the built image remains available locally.

Live Twilio SMS, SES email, S3 moderation/archival, phone interaction and public TLS require staging verification with the deployment's actual services. Automated provider mocks do not establish that those services work. Existing dependency advisories and the release gates listed in [DEPLOYMENT.md](DEPLOYMENT.md) remain open.

Use [DEPLOYMENT.md](DEPLOYMENT.md) for environment configuration, migration, hosting and mobile integration instructions.
