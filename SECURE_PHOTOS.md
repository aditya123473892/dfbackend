# Secure photo uploads

The IDE path darkfantasy-runtime/backend is a Windows directory link to
backenddf/df-backend-pm-be. Both paths refer to the same files and .env.
The launcher executes that backend. Backend source and non-secret configuration
are now visible to Git; node_modules, build output, dumps and .env stay ignored.

## Request flow

The mobile uploader uses native `FileSystem.createUploadTask` multipart POSTs
on Android/iOS, avoiding differences in JavaScript fetch/FormData between Expo
versions. Web uses fetch with a Blob. Both require S3 HTTP 204 before calling
confirmation. Upload errors identify preparation, issuance, S3 transfer or
confirmation without exposing signed fields or tokens. Profile photo changes
are available under Profile > Edit profile > Change profile photo and send the
confirmed upload ID to `PUT /api/users/me/avatar`.

The real HTTP flow was also exercised with an isolated diagnostic database:
upload-url 201, S3 POST 204, confirm 201, post 201, avatar 200 and chat image 201.
Diagnostic accounts, objects and the temporary database were removed. This is
backend/S3 validation; testing the native uploader on a physical phone remains
separate. `scripts/check-mobile-upload.js` is a local development diagnostic
that creates disposable accounts in its configured database and cleans them up;
do not run it against production.

### Standalone S3 test page

Run `npm run s3:test` from this backend directory and open
http://127.0.0.1:9011 on this computer. It uploads a generated sample to S3,
then lets you upload, preview, download, get a two-minute private S3 link,
and delete diagnostic images. Credentials stay in the server-side `.env`.
The page binds only to loopback and requires a per-process token for its API.
Images go through the diagnostic server to S3, independently of Expo, browser
S3 CORS, the database, moderation and post creation. Success confirms S3 Put/Get
access, not the app's direct-upload or publishing flow. Objects are under
`temp/diagnostics/`; delete samples on the page when finished. Stop the command
to close the test page. No app API or Expo server is started by this command.

For local upload testing with existing S3 permissions, set `NODE_ENV=development`,
`PHOTO_MODERATION_MODE=development-bypass` and
`PHOTO_VERIFY_BUCKET_SETTINGS=false` in the backend `.env`, then restart.
This still verifies and sanitizes real images but does not scan their content;
test photos follow the normal publish flow without a moderation decision.
No Rekognition or bucket-settings read permission is needed in this mode.
S3 object permissions are still required, and version-aware background deletion
still needs the documented listing/version permissions. The moderation bypass
is rejected at startup and processing time outside development/test. Restore
`PHOTO_MODERATION_MODE=rekognition` and bucket verification before deployment.

1. Authenticated `POST /api/photos/upload-url` accepts only
   `{contentType: "image/jpeg" | "image/webp", requestId}`. A request ID is an
   8–64 character idempotency key. Keys are generated on the server.
2. Send the returned form fields and file directly to S3. Require HTTP 204.
3. `POST /api/photos/confirm` with `{uploadId}` verifies ownership, HEAD size/type,
   reads no more than 5MB with an ETag condition, checks magic bytes, decodes
   at most 40 million pixels, strips metadata, resizes, and calls Rekognition.
   Any returned moderation label (confidence >=60) rejects publication. An
   unavailable or inconclusive scanner also rejects publication.
4. Only the sanitized JPEG is stored at `users/{owner}/photos/{uuid}.jpg`.
   Confirmation retries are idempotent and processing claims are fenced.
5. Submit `photoIds` to posts/chat, or `{uploadId}` to the avatar/group route.
   A photo can bind to one resource only. Post/message retries use `clientId`.

POST/confirm quotas and rates are persisted in MongoDB. Default quota is 20
pending/approved/attached images total per account, not 20 per request. Slots
have a unique `(owner,slot)` index, so separate backend processes cannot
overbook the quota. Index creation failure prevents startup.

API multipart image endpoints are no longer supported. Videos require their
own processing/moderation pipeline and are rejected. Legacy Next.js clients
must adopt this JSON/photo-ID contract before using image uploads.

## AWS deployment prerequisite

`infrastructure/photo-storage.cloudformation.json` creates separate dev/prod
buckets with all public access blocked, ACLs disabled, SSE-S3 encryption,
versioning, one-day temp expiry and incomplete-multipart cleanup. It has no
public allow policy. It retains buckets on stack deletion. Deploy it with an
existing application role and `CAPABILITY_IAM`, using a separate stack for
each environment. Native Expo needs no CORS; BrowserOrigin is optional and
must be one exact HTTPS origin. Set the same value in PHOTO_WEB_ORIGINS.

Do not accidentally replace the current bucket with an empty new bucket.
Import/harden an existing bucket through your infrastructure process, or plan
an explicit object migration and environment cutover.

Upload issuance and signed delivery verify the private-bucket settings and
fail closed if those settings cannot be read or are unsafe by default.
At the user's request, local `.env` temporarily sets
`PHOTO_VERIFY_BUCKET_SETTINGS=false` to skip these configuration checks.
Remove that setting or set it to `true` and restart to restore verification.
This override does not grant object or moderation permissions. The supplied
credentials returned AccessDenied for configuration checks during this task.
No AWS policies or bucket settings were changed. An AWS administrator must
apply/verify the settings and grant the role the template's permissions.

Object permissions are limited to temp/* and users/*. Version purge needs
s3:DeleteObjectVersion and prefix-scoped s3:ListBucketVersions in addition to
normal Put/Get/Delete; account cleanup also needs prefix-scoped ListBucket.
Separate bucket-scoped read permissions verify configuration. Rekognition
DetectModerationLabels does not support a bucket/object resource ARN: its
separate policy uses Resource "*", restricted to one action and AWS region.
For migration/deletion of old prefixes, temporarily grant exact legacy prefix
permissions (posts/*, avatars/*, events/*, groupIcon/*, chat-media/*) on the
specific bucket, then remove them when migration completes.

Use IAM roles in deployment. Local static credentials use AWS_ACCESS_KEY,
AWS_SECRET and optional AWS_SESSION_TOKEN. AWS_S3_REGION and
AWS_REKOGNITION_REGION must match your configured services. No AWS values go
in EXPO_PUBLIC_* or Expo build configuration.

## Existing photos

Legacy images are hidden until processed; they are never trusted solely
because an old record says approved. Existing signed URL values are not
forwarded. An operator can inventory and migrate them:

```powershell
npm run photos:migrate
npm run photos:migrate -- --apply
```

Inventory connects to the DB and creates required indexes but does not change
photo records or S3 objects. Apply reuses the same size/type, processing,
moderation and quota gates. Non-JPEG/WebP, oversized, missing, rejected and
permission-denied items remain hidden and count as failures. It performs
compare-and-set updates so concurrent changes are not overwritten; it reports
counts without printing URLs, keys or secrets. It does not auto-approve posts.
Take a database backup and review the inventory before applying a production
migration. This task did not run a migration against application data.

## Deletion and recovery

Object deletions are durable MongoDB jobs, retried with backoff. A worker checks
live references before deleting; shared legacy objects survive until no live
reference remains. Versioned photo data is purged, not merely hidden by a
delete marker. The worker never forgets failed deletions. Temp deletion waits
until the signing window has ended. Unattached approved images expire after
one day. Existing GET links may remain usable for at most 120 seconds.

DELETE /api/users/me queues an account purge and disables authentication
immediately. The worker waits 10 minutes for upload/processing windows to
close, removes owned photo objects and their versions before deleting DB
records, and retries failures. Keep the scheduler running and monitor
PhotoDeletionJobs/AccountPurges for sustained backlogs.

Do not restore old signing secrets from Docker defaults. Configure strong
production JWT/encryption secrets separately; rotate any previously deployed
development defaults. Bucket policy/IAM deployment and a real device/S3
upload test are required before treating this as production-verified.
