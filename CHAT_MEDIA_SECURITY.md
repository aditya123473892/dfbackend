# Secure chat media backend

## API

All routes require the existing bearer JWT.

- `POST /api/chats/messages` accepts multipart fields `receiver` or `groupId`
  (exactly one), optional `message`, optional ISO `expiresAt`, and repeated
  `media` files.
- `POST /api/chats/messages/:messageId/media/:mediaId/access-url` returns an
  authorized short-lived S3 GET URL.
- `PATCH /api/chats/messages/:messageId/media/:mediaId/revoke` lets only the
  original sender revoke an attachment.
- `PATCH /api/chats/messages/:messageId/media/:mediaId/expiration` lets only
  the original sender set or clear attachment expiration.
- `GET /api/chats/media?receiver=:userId` and
  `GET /api/chats/media?groupId=:groupId` list media metadata for one
  authorized conversation. Object keys and signed URLs are never included.

Socket.IO clients authenticate with `auth: { token: accessToken }`. Query
string user IDs are ignored. Direct message peers and group IDs remain payload
fields, but the sender always comes from the verified JWT.

## Existing records

New attachments store a randomized `chat-media/<uuid>.<extension>` private S3
key in `media.storageKey`. The browser receives an attachment ID and safe
metadata only.

Legacy attachments are not deleted or rewritten. When a legacy record has a
`filename`, it is treated as the historical S3 object key only after message
authorization and can use the new access-URL route. A deterministic public
media ID is generated for legacy subdocuments that did not have `_id` values.
The old stored `url` is never returned or trusted. If a legacy record has only
an expired URL and no usable `filename`, the attachment remains represented in
history but cannot be recovered or securely re-signed.

No database migration is required for deployment. A later background migration
may copy `filename` to `storageKey` after verifying the object exists, but must
not remove the legacy fields until all deployed readers use this API.

## Operational requirements

The S3 bucket must have public access blocked and must not grant anonymous
`GetObject`. The application does not set a public ACL. Signed URL TTL is
clamped to 60–300 seconds.

`scanMedia()` in `ChatService` is the integration hook for antivirus/content
scanning. It currently permits files after allow-list, size, and magic-byte
validation. Connect a scanner there (or replace it with an asynchronous
quarantine workflow) before deployment where malware scanning is required.

Audit documents record actor, message/media/conversation identifiers, action,
timestamp, and minimal metadata. They never contain tokens, signed URLs, raw
media, or request headers.
