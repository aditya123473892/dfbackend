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
