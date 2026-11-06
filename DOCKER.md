# Running the backend with Docker

The backend is published as a ready-made Docker image, so anyone can run it without
installing Node, MongoDB or the source code's dependencies.

| Image | What it is |
| --- | --- |
| `ghcr.io/aditya123473892/dfbackend:3112026` | Latest build of branch `3112026` |
| `ghcr.io/aditya123473892/dfbackend:latest` | Latest build of `main` |
| `ghcr.io/aditya123473892/dfbackend:sha-<commit>` | One exact commit |
| `ghcr.io/aditya123473892/dfbackend:1.2.3` | A release tagged `v1.2.3` |

Images are built for `linux/amd64` (Intel/AMD, most servers) and `linux/arm64` (Apple Silicon,
ARM servers). GitHub Actions publishes them automatically after the tests pass on every push.

## Run it locally (API + MongoDB)

Needs Docker Desktop (or Docker Engine with Compose v2).

```sh
git clone https://github.com/aditya123473892/dfbackend.git
cd dfbackend
cp .env.docker.example .env.docker      # Windows PowerShell: Copy-Item .env.docker.example .env.docker
docker compose up -d
```

- API: <http://localhost:9000/api>
- Health: <http://localhost:9000/api/health/ready>
- Swagger docs: <http://localhost:9000/docs>

The stack starts three containers:

- `mongo`: MongoDB 7 as a single-node replica set (the API needs transactions). Data stays in
  the `mongo_data` volume across restarts.
- `migrate`: creates the database indexes, then exits. It never deletes data.
- `backend`: the API on port 9000.

Everyday commands:

```sh
docker compose logs -f backend     # follow API logs
docker compose pull && docker compose up -d   # update to the newest published image
docker compose down                # stop (keeps the database)
docker compose down -v             # stop and DELETE the local database
```

To build from your checkout instead of pulling: `docker compose up -d --build`.
To run a different image: `BACKEND_IMAGE=ghcr.io/aditya123473892/dfbackend:latest docker compose up -d`.
To use other ports: set `API_PORT` or `MONGO_PORT` the same way.

### Settings

Everything is configured in `.env.docker` (never in your `.env`, and never committed). The
example works out of the box for development. Optional sections enable:

- **Photos, videos, Photo Vault:** S3 bucket and AWS keys.
- **Emails:** AWS SES. Without it, development sign-ups are verified automatically.
- **Chat with God:** `DEEPSEEK_API_KEY`.
- **Phone sign-in:** Twilio Verify.

Change `JWT_SECRET` and `PASSWORD_ENCRYPTION_PRIVATE_KEY` before anyone else can reach your
server.

### Connect the mobile app

Set the app's `EXPO_PUBLIC_API_URL` to `http://<your computer's LAN IP>:9000/api` (Android
emulator: `http://10.0.2.2:9000/api`) and run a development build.

## Production

`NODE_ENV=production` refuses to start without strong secrets, HTTPS URLs, S3, SES and the
required database indexes. For a server with Atlas, HTTPS and the Caddy proxy, follow
[DEPLOYMENT.md](DEPLOYMENT.md) and `deploy/compose.production.yml`, using the published image:

```sh
docker pull ghcr.io/aditya123473892/dfbackend:3112026
```

## Giving others access to the image

GitHub publishes new packages as **private**. Either:

- make it public: GitHub › your profile › **Packages** › `dfbackend` › **Package settings** ›
  **Change visibility** › Public; or
- keep it private and add people under **Manage access**. They sign in once with a GitHub
  token that has the `read:packages` scope:

  ```sh
  echo <token> | docker login ghcr.io -u <their-github-username> --password-stdin
  ```

## What the image contains

A two-stage build (`Dockerfile`): the build stage compiles TypeScript; the runtime image
contains only compiled code, production dependencies and email templates, runs as the
non-root `node` user, and has a health check. `.dockerignore` keeps `.env` files, the local
`.local-mongo` database, uploads, logs, tests and Git history out of the build entirely, so no
secrets or local data end up in an image.
