# Blocking and moderation rollout

## Delivery status

Phases 1–3 implement user-to-user blocking, report intake, preservation,
restricted intake, Android reporting and moderation APIs. Moderation APIs default
OFF; production enablement requires the prerequisites below. No AWS configuration
was changed. Ordinary evidence copying still defaults OFF. No staff console was built.

`Users.isBlocked` remains the existing administrative account restriction.
`UserBlocks` is a separate collection. Blocking does not change account roles,
account restrictions, vault data, group membership or stored message/post data.

## Phase 1 API

All routes require the existing verified JWT. The blocker is always the token
identity; ownership, keys and actor IDs are not accepted in request bodies.

| Route                     | Request                                              | Result                                                      |
| ------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| `POST /users/:id/block`   | Empty object                                         | Idempotent `{ blocked: true }` in existing success envelope |
| `DELETE /users/:id/block` | No body                                              | Idempotent `{ blocked: false }`                             |
| `GET /users/me/blocks`    | `limit` 1–100, default 20; optional `before` peer ID | `{ blocks: [{ id, name, createdAt }], nextCursor }`         |

Self-blocking is rejected; staff accounts can be blocked. The maximum is 1,000
outgoing blocks. Incoming blocks have no such per-recipient cap. Removing one's
own block does not remove the reverse block. Deleted targets display as “User”.
Missing and blocked profile reads retain the exact existing `User not found!`
response envelope/transport behavior. No “blocked by” explanation is returned.

Pending follows and private-post access requests are marked rejected in both
directions. Accepted relationships are retained but unusable while blocked.
Unblocking restores visibility, not rejected requests. Follow approval is restricted
to the request recipient and only accepts pending requests.

## Query and delivery boundaries

The connection-level Mongoose plugin adds visibility predicates before query
execution, counting, pagination and population. An AsyncLocalStorage context holds
the verified viewer and one request-local promise for the blocked-ID set. It is
never reused across requests. The `/mod/*` namespace is exempt from pair filtering;
it will receive separate staff/case authorization in Phase 3. Existing staff-only
tools bypass visibility only AFTER RolesGuard authorizes the current DB role.
Staff management of their own event applications also bypasses visibility, while
the existing creator ownership checks remain mandatory. Notification suppression
still applies to these actions. A role alone does not bypass ordinary profile/feed
visibility. The vault retains its separate owner-only authorization.

The plugin covers Users, Posts, Comments, Likes, Events, EventMembers, follows,
PostRequest, UserBookMark, PostBookMark, Notifications, UserEdits and direct
ChatMessages. Related bookmarks/comments/likes/attendees also exclude hidden
parent resources. Raw storage/auth queries are separately authorized. Vault
collections and the dedicated owner-only vault controller are unchanged.

Direct history/send/media, typing, receipts, presence and broadcasts recheck the
pair using fresh MongoDB reads. Both sockets are disconnected after a mutation;
MongoDB change streams distribute invalidation across backend instances. Neither
the invalidation event nor its payload identifies the other user or block reason.
Clients reconnect and refetch authorized state. No push integration exists.

Shared groups retain membership and text. Android collapses blocked senders to
“Blocked user, tap to show”. Revealing text does not enable media/profile/DM
access. Group history and real-time payloads strip blocked senders' image metadata;
signing and API byte delivery deny access to their images.
Structured mention functionality does not currently exist. Group directories omit
phone numbers for everyone. Removing a member evicts its sockets, and broadcasts
address only currently authorized members rather than trusting old subscriptions.

Legacy chat sender/recipient/group fields may contain either ObjectIds or strings.
Visibility and conversation queries intentionally support both BSON forms without
changing the existing schema or single-opening claim semantics.

Chat image GET URLs default to 120 seconds, configured by
`CHAT_MEDIA_URL_TTL_SECONDS` within 60–300 seconds. Already issued URLs remain
usable until expiry. New signing and restricted-photo byte delivery recheck
blocking. Upload POST URLs last 300 seconds; generic uploads are owner-only and
do not confer permission to bind/send the upload to a blocked peer.

Android removes affected TanStack caches, local user summaries, histories and
outbox entries optimistically. Errors restore snapshots, preserving any other
concurrent block and preventing old-session rollback. Pending sends restored after
an error are uncertain and require explicit resync. Late social GET responses
from an earlier visibility version are discarded. Block mutations are not queued
offline or automatically retried.

## Database rollout

A MongoDB replica set (or transaction-capable sharded cluster), logical sessions,
transaction permissions, primary read preference and change-stream permissions
are required. A single-node replica set is sufficient; standalone MongoDB is not.
Startup validates topology and performs a read-only transaction probe BEFORE
index work or socket invalidation streams. Unsupported topology or a failed probe
throws an explicit UserBlocks requirement error and prevents server startup.
There is no standalone fallback. `UserBlockQuotas` contains a per-blocker revision
used to serialize both block and unblock transactions, including the 1,000-block
check; it never touches `Users`. Concurrent callers retry transaction conflicts.

Indexes MUST be installed before switching traffic to the blocking code. Keep the
old deployment serving while preparing the new release artifact and operator CLI:

1. Confirm replica-set/cluster transaction and change-stream support, primary read
   preference and operator/application DB permissions. Back up the database.
2. In the backend directory, set `DATABASE_URL` and `DATABASE_NAME` in the operator
   environment (the CLI does not load `.env` or print credentials). Run
   `npx ts-node scripts/user-block-indexes.ts --report`. This is read-only and
   reports duplicate `(blockerId, blockedId)` pairs. If any exist, stop, review
   and reconcile them explicitly; the tool never deletes or merges records.
3. Pause any existing block writers, rerun `--report`, then run
   `npx ts-node scripts/user-block-indexes.ts --apply`. Apply refuses duplicates.
   Existing collections also need the standard unique `_id_` indexes, including
   `UserBlockQuotas`; MongoDB creates those automatically when created.
4. Inspect `db.UserBlocks.getIndexes()` in the selected database; verify the exact
   keys, names and unique option listed below, and re-run the duplicate report.
   Resolve any existing same-name/different-options index manually before retrying.
5. Only after successful verification, deploy/cut over the backend with
   `USER_BLOCK_INDEXES=off` (default), then release the Android client. Smoke-test
   both block directions, media denial, reconnect and unblock. Resume writers.

The optional application flag `USER_BLOCK_INDEXES=report|apply` remains available
for controlled environments, but startup is not the production indexes-first
rollout mechanism. No index command was run against an application database.

Required indexes on `UserBlocks`:

- `block_pair_unique`: `{ blockerId: 1, blockedId: 1 }`, unique.
- `blocked_user`: `{ blockedId: 1 }` for incoming blocks.
- `block_page`: `{ blockerId: 1, _id: -1 }` for cursor pagination.

New records use deterministic string `_id = blockerId:blockedId`, independent of
the opt-in secondary indexes. No application/AWS database was migrated by this
implementation. Apply the reviewed indexes before enabling production traffic.

## Verification

From the backend: `rtk npx tsc --noEmit --incremental false` and
`rtk npm test -- --runInBand`. MongoDB integration suites run only when
`TEST_MONGO_URI` is supplied and always create randomly named disposable databases.
Never point integration tests at a production MongoDB host.

`scripts/test-with-mongo.cjs` provisions a disposable local replica set and runs
the full Jest suite. Install `mongodb-memory-server` in a separate test-tools
directory, then pass its absolute module path as the runner's first argument;
without an argument it resolves the installed package normally. It never reads
`DATABASE_URL`. Real-database tests use a 15-second timeout with unchanged
assertions. The process shuts down its replica set after Jest exits.

From the Expo root: `rtk npm run typecheck` and
`rtk node --test scripts/test-auth.cjs scripts/test-vault.cjs scripts/test-dev-api-proxy.cjs scripts/test-events.cjs scripts/test-blocks.cjs`.

The surface integration suite exercises both directions separately, using real
production schemas/services and a disposable replica set. HTTP profile tests
compare status, raw response bytes and the normalized Mongo find command sequence.
This proves equal application query work, not constant network/DB wall-clock time.
Real Socket.IO clients verify block disconnect, reconnect, group image denial and
eviction of two devices belonging to a removed group member on one backend instance.
Distributed Socket.IO adapter behavior is not exercised by this test harness.

No notification push/queue delivery worker or active notification controller exists.
Tests cover persisted notices created before a block, filtered model reads/counts,
and creation after a block. There is no separate attendee-count response field;
preview length and the accepted-member count query are tested.

## Manual Android verification (pending device execution)

Use two accounts A/B, a third observer C, an existing direct conversation with
images, accepted/pending follow/access requests, and a shared group. Test both
block directions and use two B devices for the removal check.

- Profile menu: block B, inspect the explanation, cancel once, then confirm.
- Chat header: repeat the block action; verify the direct inbox disappears on
  both accounts and sending, image opens and profile opens fail after reconnect.
- Message long-press: block from a direct message and from a group message.
- Settings > Blocked users: verify minimal names, pagination, unblock and errors.
- Unblock: discovery/profile/feed/chat visibility returns; rejected pending
  follow/access requests remain rejected. A reverse block still prevents access.
- Offline: block/unblock fails visibly, optimistic state rolls back, reconnect
  does not silently replay the mutation. Also exercise a server-error rollback.
- Shared group: membership remains; blocked messages say "Blocked user, tap to
  show". Reveal text; peer images stay inaccessible. All directory phone numbers
  are absent. Remove B; both B devices lose the room and subsequent delivery.
- Cache purge: preload directory, discovery, profile, feed, bookmarks and inbox;
  block, navigate back immediately, then let old requests complete. No stale peer
  content or cached direct-chat fallback returns. Repeat logout/account switching.
- With A blocking a staff account B, verify B can still use existing admin tools
  and manage B's own posts/events/applications; ordinary browsing remains filtered.
- Vault: confirm the owner still opens their own vault and another account/staff
  cannot access it. Wait for an already-issued chat URL's configured TTL and verify
  expiry separately from immediate denial of new signing/API-byte delivery.

Report/offline-draft UI belongs to Phase 2 and is not part of this checklist.

## Phase 2 API and storage

All routes use the verified JWT identity, never a body/query reporter ID.

| API | Contract |
| --- | --- |
| `POST /reports` | Strict Zod body: `targetType`, `targetId`, `category`, optional `details` <=500 characters, optional `childSafetySuspected`; `messageId` required only for `chat_media`. Returns only case ID, status and target owner ID for the block offer. |
| `GET /reports/me?before=&limit=` | Only the authenticated reporter's case ID/status/createdAt; cursor pagination, maximum 100. No target, reporter, evidence, category or staff resolution details. |
| `GET /reports/notices` | Only the reporter's system receipt messages. No recipient/target identity in the response. |

Supported targets: user, post, chat_message, chat_media, group, event. Supported
categories: harassment, hate, spam_scam, fake_profile, nudity_sexual,
violence_threat, underage, self_harm, impersonation, other. IDs normalize to
lowercase before dedupe. Self reports and unknown/privileged body fields fail.
Notes remove control characters and escape HTML characters before storage.

Collections (raw MongoDB, no automatic indexes or TTL):

| Collection | Fields and purpose |
| --- | --- |
| `Reports` | UUID `_id`/reportId, reporterId, targetType/targetId/targetOwnerId, category, escaped details, status, `open`, evidenceSnapshotRefs, conversationId/messageId, createdAt, assignedModerator, resolution, resolvedAt, legalHold, restricted, priority, eligible, eventual evidencePurgedAt. |
| `ReportEvidence` | UUID, reportId, timestamped source text snapshot, preceding context, images with immutable sourceKey/evidenceId/state and copied s3Key. No public reader. |
| `RestrictedReportEvidence` | Separate admin-only restricted text snapshots. No HTTP/socket reader or download endpoint. Restricted image destinations remain unallocated pending legal guidance. |
| `ReportHolds` | Case ID, active, resources (`collection:id`, `owner:id`, `key:s3Key`), createdAt/releasedAt. Includes the context sources and their image keys. |
| `ReportEvidenceJobs` | Deterministic evidence-image ID, case/evidence references, sourceKey, destinationKey, restricted, state, attempts, dueAt/copiedAt. |
| `ReportAccess` | Deterministic viewer/resource ID, viewerId, resource, firstSeenAt/lastSeenAt; proof of authorized outward presentation. |
| `ReportMemberships` | Deterministic group/user ID, groupId/userId/leftAt, written before removal. |
| `RestrictedContent` | Source ID, collection/contentId/ownerId, private case ID, createdAt. Drives query, signing and socket suppression. |
| `ReportReviewQueue` | Target-owner queue entry, distinct eligible reporter count, restricted/priority, timestamps. No automatic ban or ordinary-category hiding. |
| `ReportReporterPolicies` | Operator-only spam/excluded/abusive flags, per-day rate-limit hit count. No public mutation endpoint. |
| `ReportCoordination` | `_id=sources`, unpredictable token, startedAt, process ID and leaseUntil. Renewable 60-second lease, renewed every 20 seconds. Expiry alerts; no TTL or automatic takeover of in-flight storage work. |
| `StaffAuditLog` | Phase 2 inserts only a system restricted-preservation/escalation event with case ID, target/content ID, reason and timestamp. No user routes or URL logging. Staff viewing and its insert-only DB principal belong to Phase 3. |

## Internal access, transactions and deletion coordination

The internal `readReportSource` function reads raw collections inside the intake
transaction. It does not call user-facing chat history, signing or media readers,
does not use pair-block filtering, and is not exported by a Nest module/controller.
Only intake invokes it after deriving identity from the JWT. It never reads vault
content. It snapshots allowlisted profile/post/event/group text, or message text,
sender and timestamp plus at most the 20 immediately preceding messages of the
same direct pair/group. Future/other-conversation messages are excluded.

Direct message sender/recipient identity proves prior access even after blocking.
Groups require current membership or a removal ledger; former members cannot
report messages sent after removal. Existing current memberships work without
migration. Historical removals before this code had no ledger: if membership
cannot be proved server-side, intake rejects rather than accepting client claims.
Profiles/posts/events use server-written presentation receipts, or current normal
visibility when unblocked. The first pair block records the profiles' immediately
preceding mutual visibility. No blanket prior access is granted to private posts.
Previously blocked content without a receipt cannot acquire one retroactively.

Report, snapshot, source/key/owner hold, image jobs, receipt and any restricted
marker/escalation are one replica-set transaction with snapshot reads and a
majority commit; gate acquisition/release also require majority acknowledgement.
Open-case lookup precedes
limits; duplicate/retried submissions return the existing case. The distributed
gate serializes intake against sender deletion, revoke/expiry edits, post/event
deletion, physical cleanup and account purge, including S3 calls. Destructive
requests return the normal successful delete/revoke response, removing the source
row or revoking its media normally. Text is already in the immutable snapshot;
key holds defer physical byte deletion. Snapshots do not depend on future sender-owned records.

Gate recovery is deliberately manual and fail-closed. If a process dies while
holding `ReportCoordination.sources`, first stop that process and confirm all its
in-flight DB/S3 work has ended; inspect the token, timestamp and case/job state;
then recover exactly that expired token using the command below. Never add a TTL or steal a
lock based only on its age. Contention times out visibly after ten seconds; the
client retains its draft and never queues a sensitive report. This conservative
global gate trades throughput for preservation safety; monitor contention before
scaling. All future moderation/legal-hold writes must use the same gate.

Physical chat expiry is held as well as explicit revoke/delete. Account purge
removes non-evidence rows and unheld objects, queues held source keys for durable
cleanup, and completes without waiting for case resolution. It never traverses
`reports/` or deletes case collections. Authorized vault access remains unchanged;
vault content cannot be reported or copied into evidence.

### Phase 2 verification operations

An expired lease emits `report_gate_expired count=1` every minute; contention emits
`report_gate_busy` (no token, case or object details). The minute metric
`report_preservation` contains only the distinct held-source count and pending-copy
job count, including restricted jobs awaiting legal guidance. Alert on expired
gate, rising pending jobs or prolonged hold growth. These are structured application
logs; connect them to the deployment's alerting system.

Recovery: stop the holder process/container; confirm its DB/S3 operations have
settled. Inspect `ReportCoordination` privately for the observed token and expired
lease. From the backend directory run:

```powershell
rtk proxy npx ts-node scripts/recover-report-gate.ts --holder-stopped --token=<observed-token>
```

The command requires the exact token and an expired lease (legacy locks lacking
a lease are recoverable after the same stopped-holder check). A changed token or
live lease refuses recovery. Never use it while the old holder can resume. Failed
account purges and byte cleanup retain durable jobs with attempts/backoff, up to
one hour, and retry after recovery; an active source hold reschedules byte cleanup
every minute until retention releases it. No job is acknowledged on gate failure.

Deletion transport behavior is identical with/without a hold: HTTP post/event
DELETE returns 200 and its existing success JSON (`data: {deleted: true}`);
media revoke returns 200 with `message: "Media revoked"` and the revoked message.
The existing response envelope's `statusCode` is 200. Chat-message deletion uses
the socket `deleteMessage` command and normal `messageDeleted` payload; there is
no HTTP message-delete endpoint. Held deletes emit no special error/event.
Already issued object URLs remain valid for their original TTL; future revoked
media signing is denied. No case/hold field is exposed.

Historical group membership that cannot be verified returns HTTP 403:
`We could not verify your prior access to this conversation. Please contact support.`
The response contains no group/member IDs or evidence details. Android renders
the API error and retains only its in-memory draft. Profile evidence includes
the original bio and avatar key (the current profile has a single avatar field);
the image job and key hold preserve that original photo after replacement.

Report notes are sanitized/escaped at intake; all current reporter APIs omit them.
Snapshot content remains private and has no read route. A future staff UI must
escape snapshot text on output. Report code logs counts/static errors only;
HTTP middleware logs method/path/status/duration, never request bodies or query
strings. Recovery prints no tokens or database exceptions. No evidence signer
or download API exists in Phase 2.

Safe copy enablement (operator steps only; no AWS changes were applied):

1. Leave `REPORT_EVIDENCE_COPY=off`; deploy and verify the proposed IAM grants below
   for source read and ordinary `reports/` write/delete, bucket public access block,
   private prefix and encryption. Exclude `reports/` and held source objects from
   lifecycle expiry; do not configure an evidence TTL. Confirm the service cannot
   generate public evidence links. Restricted storage remains undecided/off.
2. In staging, create one ordinary image report using consenting test accounts.
   Verify report + immutable text + active key hold + `copy_pending` job exist.
3. Enable copying on one canary backend/worker only and restart it. The shared
   gate coordinates all instances. The flag currently processes all due ordinary
   pending jobs, so inspect the backlog first; there is no per-case canary flag.
4. Privately verify destination bytes/checksum, empty replaced metadata, private
   access, encryption and no-store; confirm both job and snapshot say `copied`.
   Delete/revoke the source through the app and verify evidence still exists.
5. Enable other workers; observe pending ordinary jobs drain every minute (20 per
   tick) and attempts/backoff on failures. Restricted jobs must remain
   `restricted_pending_legal`. Disable the flag if checks fail: text/holds/jobs
   remain intact, then fix IAM and retry. Never delete source holds to drain jobs.

## Evidence copying, retention and review

Approved report defaults: 20 preceding messages from only the reported
conversation; 10 reports per reporter/hour and 3 per target/24h; dedupe open cases;
90 days after resolution, subject to legal review/hold. Prior legitimate access,
including before a block, must authorize report intake.

Intake atomically preserves text, creates the case and holds its source.
Image copies are durable asynchronous work, controlled by
`REPORT_EVIDENCE_COPY=off|on`, default off until the IAM update is deployed. While
off, retain the report/text/source hold and mark images `copy_pending`. The minute
worker picks up pending ordinary images when enabled, uses an immutable
`reports/{reportId}/{evidenceId}.jpg` destination, conditional ETag copy,
MetadataDirective REPLACE with empty metadata, AES256 encryption and no-store.
Failures retain the job/hold and retry with bounded exponential backoff. Repeated
attempts use the same destination. Generic URL signing refuses `reports/`.

The hourly retention worker defaults to 90 days after resolution. It skips open,
unresolved, legal-held, restricted and pending-copy cases. Under the gate, it
rechecks current case status/hold immediately before each object deletion and
again in the DB transaction that releases the hold/removes snapshots. A storage
failure keeps the hold and job for retry. Minimal case/status metadata remains;
text/evidence details are removed. No evidence TTL or S3 automatic expiry is used.
Restricted cases never auto-expire pending the legal answers below.

Ordinary categories enter review at five eligible distinct reporters in seven
days; underage or nudity_sexual enters review after one report. Nudity reports
alone must not auto-hide content. Only restricted child-safety cases auto-hide.

Restricted reviewers are admin/root only; Phase 2 exposes no evidence reader to
any user or staff role. Underage or explicit child-safety suspicion immediately
hides the source, preserves it and queues/audit-logs escalation. Chat-media
restriction hides its containing message. Existing staff pair-filter exemptions
do not bypass restricted-content hiding. Each backend watches committed restricted
markers and sends only an empty `visibilityChanged` event to its local connected
clients. Android advances the visibility version, cancels/resets active social
queries and rejects late pre-restriction responses. No case, target or reporter
identifier is broadcast. The owner's exact `/auth/me` self lookup stays available
so profile hiding does not disable authentication or owner-only vault access;
this exception cannot fetch any other account. **Restricted evidence storage location,
retention and viewing details remain unfinalized pending the owner's legal
guidance.** No restricted evidence prefix or AWS policy has been implemented.
No external reporting integration is built. Restricted images remain
`restricted_pending_legal`, even when ordinary copying is on. No restricted S3
prefix is allocated or finalized in this phase.

Defaults/configuration:

| Setting | Default |
| --- | --- |
| `REPORT_INDEXES` | off; report/apply are operator opt-ins |
| `REPORT_EVIDENCE_COPY` | off |
| `REPORT_RETENTION_DAYS` | 90, pending legal review |
| `REPORT_USER_HOURLY_LIMIT` | 10 |
| `REPORT_TARGET_DAILY_LIMIT` | 3 per reporter + target / rolling 24 hours |
| `REPORT_REVIEW_DISTINCT_THRESHOLD` | 5 |
| `REPORT_REVIEW_WINDOW_DAYS` | 7 |
| `REPORT_ABUSE_LIMIT_HITS` | 10 rate-limit violations in a day flag abusive reporting |

Open duplicates do not consume a new rate allowance or increase review weight.
Verified, non-spam/non-excluded/non-abusive reporters count once per target owner
in the review window. Current reporter-policy exclusions also remove old votes
from weighting. One eligible nudity report queues review; any child-safety report
queues highest-priority admin review. Queue priority cannot be downgraded by a
later ordinary report. Abusive-reporting flags do not ban or hide an account.

Only an in-app system receipt is created in Phase 2. It contains no target,
category, note, reporter identity or evidence. Other participants/targets receive
no report notification/socket event. System receipts remain available to their
authenticated reporter despite pair blocks. Other peer-created notices retain
the existing block checks. Outcome notices belong to Phase 3 actions; no push.

## Report index rollout (indexes before code cutover)

1. Prepare the new artifact without starting its API. Confirm replica-set
   transactions and operator credentials; back up the database. Keep the old
   deployment serving and pause any existing report writers during application.
2. In the backend directory, set DATABASE_URL/DATABASE_NAME in the operator
   environment; run `npx ts-node scripts/report-indexes.ts --report`.
3. Review duplicate open cases. Resolve them explicitly; the tool never deletes
   evidence, holds or duplicate cases. Rerun the report until clean.
4. Run `npx ts-node scripts/report-indexes.ts --apply`. It refuses duplicates.
5. Verify `getIndexes()` on the collections below, then deploy the backend with
   REPORT_INDEXES=off and REPORT_EVIDENCE_COPY=off. Only enable copying after the
   reviewed IAM/lifecycle changes are deployed by the owner. Release Android.

`Reports`: partial unique `(reporterId,targetType,targetId)` WHERE open=true;
reporter pagination `(reporterId,createdAt DESC,_id DESC)`; target rate
`(reporterId,targetType,targetId,createdAt DESC)`; review
`(targetOwnerId,eligible,createdAt DESC)`; retention `(status,resolvedAt,legalHold)`.
`ReportHolds`: `(resources,active)`. `ReportEvidenceJobs`: `(state,dueAt)` and
`(reportId)`. Both evidence collections: `(reportId)`. `ReportAccess`: unique
`(viewerId,resource)`. `StaffAuditLog`: `(reportId,timestamp)`. Other collections
use deterministic unique `_id` indexes. **No TTL indexes.** No application DB
index command has been run by this implementation.

## Proposed IAM/lifecycle diffs — review only, not applied

These are templates for the existing backend role and private bucket; replace
placeholders and merge into the owner's actual policy. Source reads remain
limited to existing app media prefixes. S3 CopyObject requires source GetObject
and destination PutObject permissions ([AWS permissions reference](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html)).

```diff
+ { "Sid": "WriteOrdinaryReportEvidence", "Effect": "Allow",
+   "Action": ["s3:PutObject"],
+   "Resource": "arn:aws:s3:::PRIVATE_BUCKET/reports/*",
+   "Condition": { "StringEquals": { "s3:x-amz-server-side-encryption": "AES256" } } }
+ { "Sid": "NeverReadEvidenceThroughAppCredentials", "Effect": "Deny",
+   "Action": ["s3:GetObject", "s3:GetObjectVersion"],
+   "Resource": "arn:aws:s3:::PRIVATE_BUCKET/reports/*" }
+ { "Sid": "CaseRetentionDeletes", "Effect": "Allow",
+   "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion"],
+   "Resource": "arn:aws:s3:::PRIVATE_BUCKET/reports/*" }
+ { "Sid": "CaseRetentionVersions", "Effect": "Allow",
+   "Action": ["s3:ListBucketVersions"],
+   "Resource": "arn:aws:s3:::PRIVATE_BUCKET",
+   "Condition": { "StringLike": { "s3:prefix": ["reports/*"] } } }
```

Retain bucket-wide public-access blocking, bucket-owner-enforced ownership,
encryption and denial of insecure transport. No public object ACL/bucket policy
or staff-read grant is added by the Phase 2 template. Phase 3's separate delta
below must be reviewed before staff viewing works with that deny statement.
Restricted storage, its principal/key and any restricted grants remain undecided.

```diff
- Any bucket-wide expiration/noncurrent-version deletion rule covering reports/
- Any source-media expiry rule that can destroy an object protected by a DB hold
+ Scope ordinary automatic expiration to unheld disposable prefixes such as temp/
+ Keep reports/ objects AND versions until the case-aware retention worker deletes them
+ Keep AbortIncompleteMultipartUpload; it does not expire completed evidence
```

Do not deploy an age-only lifecycle rule for reports/, including noncurrent
versions. Existing S3 lifecycle/manual deletion outside the application cannot
honor a MongoDB hold; the owner must confirm those policies before enabling
intake/copying in production. No restricted-prefix lifecycle is proposed yet.

## Android report checklist (manual device execution pending)

- Profile (including a previously blocked profile), post options, message
  long-press and normal/view-once image viewers each open the correct report target.
- Choose every category; optional note caps at 500 characters. Explicit child-
  safety suspicion selects restricted intake. No screenshot/image is uploaded by
  the report screen.
- Double tap submit: one request/case. Check the success state, also-block offer,
  block confirmation and My reports status/receipt. Refresh and paginate statuses.
- Airplane mode: clear error, no network request/queue; draft survives navigation
  in memory. Reconnect sends nothing until an explicit submit. Kill/relaunch or
  log out/switch accounts: the sensitive draft is gone.
- Simulate failed/timed-out POST, then explicitly retry: the same open case is
  returned. A late old-session response cannot reopen the success/block offer.
- Report after either block direction. Report a former group's pre-removal
  message; reject a post-removal message or a conversation never joined.
- With three group participants, confirm only the reporter sees the receipt/case;
  targets/peers see no reporter identity or report socket event.
- Ordinary/nudity reports leave content visible; child-safety content disappears
  on subsequent authorized reads/signing/live delivery. Check no evidence URL or
  download control exists. Previously delivered bytes/issued source URLs cannot
  be remotely recalled; existing source URL TTLs still apply.
- Repeat vault/chat/block regression checks. Phase 3 console/actions remain absent.

## Multiple backend instances: deployment changes required

The current gateway uses the default in-memory Socket.IO adapter and process-local
userSockets/onlineAdmins maps. No distributed adapter is configured or installed.
Before running multiple instances, configure a compatible shared adapter in the
Nest IoAdapter before listening (for example the Redis adapter), shared namespace/
channel settings, authenticated/private transport and monitored adapter readiness.
Adapter socket-management support is required for cross-node disconnectSockets
and socketsLeave ([Socket.IO Redis adapter](https://socket.io/docs/v4/redis-adapter/)).

With HTTP polling enabled, configure load-balancer sticky sessions as required by
the adapter documentation; alternatively explicitly verify WebSocket-only clients
and load-balancer support. Do not assume reconnect/state recovery is provided by
the Pub/Sub adapter. Android already reconnects/refetches authorized state.

An adapter alone does not fix process-local presence: aggregate account socket
counts across nodes before marking a user offline, and deliver presence to
cluster-wide authorized viewers. Share group-removal/account-deletion invalidation
or ensure adapter room operations reach all nodes. UserBlocks change streams
already distribute block invalidation, but fresh DB authorization must remain at
every delivery/signing point. Test two nodes with the same account connected to
both: block disconnect, remove-member eviction, typing/receipts/presence, group
media hiding and adapter outage/reconnect. This deployment change/test is not
performed in Phase 2.

Report intake/copy/retention/deletion use a shared MongoDB gate rather than a
process-local mutex, so multiple cron instances cannot duplicate active work.
Monitor its contention and fail-closed recovery procedure above. Keep API/source
deletion writers on the same release; an old backend that ignores holds must be
drained before accepting reports. Do not run mixed old/new destructive workers.

## Phase 3 moderation APIs

All routes use the `/api` prefix in the deployed app. `MOD_API_ENABLED=off` is the
default in every environment. Disabled routes return the same status/error body
as an absent route, before JWT/role checks. No staff UI is included.

Enablement in production requires `STAFF_MFA_ENABLED=on`, a nonempty
`STAFF_MFA_ISSUER`, `STAFF_TOKEN_TTL_SECONDS` between 60 and 900, and a separate
`STAFF_AUDIT_DATABASE_URL`. Otherwise startup fails. Every production /mod request
also requires a verified HS256 JWT from the configured issuer with `amr` containing
`mfa`, numeric iat/exp and a lifetime/age within the configured maximum. Role claims
in the token never grant authority: JwtStrategy reads Users, and ModCaseGuard
rechecks Users again. Ordinary password login does NOT assert MFA or mint those
claims. Staff tokens issued there now last at most 900 seconds. Keep moderation
disabled until the trusted MFA token exchange/issuer has been integrated and
reviewed; setting environment flags does not create an MFA implementation.
Do not share the signing secret with an untrusted service or the Android client.

`moderator` can review ordinary cases and act on content, but cannot change roles,
perform permanent actions, set legal holds, or see restricted cases. Admin/root
can review restricted cases. Admin may manage lower roles only; only root can
grant/revoke admin/root roles, nobody may change their own roles, and serialized
role mutations retain an active root. Users.roles validates each enum item.
Moderator is recognized by Android without granting its existing admin screens.
No staff role grants access to another account's owner-only vault. A staff member
cannot open or act on a case they reported or a case targeting their own account,
even with an admin/root role. Assignment also rejects either involved party;
ObjectId casing cannot bypass self-change or assignment conflict checks.

| Method and path | Body / result |
| --- | --- |
| GET `/mod/reports?before=` | Up to 50 open cases; opaque nextCursor. Restricted cases omitted for moderators. No reporterId or evidence keys. |
| GET `/mod/review-queue` | Up to 50 review queue entries, same restricted/own-target isolation. |
| GET `/mod/reports/:reportId` | Case and escaped text snapshots/context, image IDs/states; no storage keys or reporterId. |
| PATCH `/mod/reports/:reportId/assignment` | `{moderatorId, revision, note}`; assignee must be active and authorized for the case. |
| PATCH `/mod/reports/:reportId/status` | `{status, revision, note}`. |
| POST `/mod/reports/:reportId/actions` | `{action, revision, note, suspendedUntil?}`. |
| PATCH `/mod/reports/:reportId/legal-hold` | Admin/root only: `{legalHold, revision, note}`. |
| POST `/mod/reports/:reportId/evidence/:imageId/view` | `{reason:"case_review"}`; ordinary copied evidence returns URL + expiresIn=60, restricted evidence returns an inline JPEG stream. |

All staff responses are private/no-store. Bodies use strict Zod schemas; every
assignment, transition, action or legal-hold change requires a trimmed 1–500
character note and the current integer revision. Notes are escaped in the
case-transition journal, not copied into StaffAuditLog. Stale revisions return
409 without changing state. Mutations share the preservation gate and use MongoDB
transactions with snapshot reads/majority writes; source hide/action, status,
revision, transition journal and user notices commit atomically.

Allowed progression is `open -> in_review -> actioned | dismissed | escalated`.
Escalated cases remain open with no resolvedAt, cannot be actioned by moderators,
and do not age out. Admin/root can return them to in_review or resolve them.
Closed cases are terminal except assignment/legal-hold metadata updates. Actions:
`dismiss`, `warn`, `soft_remove`, `suspend`, `escalate`; `ban` and `delete_account`
require admin/root. Sanctioning admin/root accounts requires root; the last active
root is protected. Suspension expires within thirty days and uses
`moderationSuspendedUntil`, independent of Users.isBlocked. HTTP authentication,
login validation and per-packet socket account checks enforce it; a MongoDB change
stream plus the local action event disconnect every account socket via its user
room. Multi-instance deployments still require the adapter/presence work above.

Soft removal hides content immediately through a source marker, writes deletedAt
and queues durable image cleanup. Active case holds defer byte deletion. Once a
resolved case passes retention and releases its hold, deleted source rows no
longer count as live references and the same cleanup job can finish. Text snapshots
and copied evidence remain independent of user deletion/account purge. Escalated,
unresolved, restricted and legal-held cases never release their holds via retention.

Staff image viewing is case-bound: an active case hold and image job for that
exact reportId must exist. The audit insert commits BEFORE signing/reading; an
audit failure denies access. Ordinary URLs last 60 seconds, request no-store and
inline disposition, and can only sign `reports/`. Pending ordinary copies return
409, never a source URL. Restricted cases use the held source via an admin/root-only
API stream: no URL, download or export endpoint. Restricted storage/retention
details remain pending legal approval; no restricted prefix has been finalized.
An inline stream cannot prevent an authorized viewer capturing bytes/screenshots;
staff workstation policy and the future console must enforce handling rules.

The Phase 2 IAM template explicitly denies GetObject on reports/. The new signer
does not bypass IAM: ordinary viewing will fail closed until an operator reviews
and deploys the following Phase 3 delta for the trusted backend principal. No AWS
change was applied. This grants private object reads to the backend process;
case/role checks remain mandatory at its only evidence signing route. It grants
no client credentials, public bucket access or generic evidence-signing path.

```diff
- "Sid": "NeverReadEvidenceThroughAppCredentials",
- "Action": ["s3:GetObject", "s3:GetObjectVersion"]
+ "Sid": "NeverReadEvidenceVersionsThroughAppCredentials",
+ "Action": ["s3:GetObjectVersion"]
  "Effect": "Deny", "Resource": "arn:aws:s3:::PRIVATE_BUCKET/reports/*"
+ { "Sid": "CaseBoundStaffEvidenceRead", "Effect": "Allow",
+   "Action": ["s3:GetObject"],
+   "Resource": "arn:aws:s3:::PRIVATE_BUCKET/reports/*" }
```

Keep public-access blocking, TLS/encryption and the case-aware lifecycle exclusions
above. Do not remove unrelated deny statements. Do not add any restricted-prefix
grant or lifecycle rule before legal approval. With the Phase 2 deny still in place,
signed requests remain unreadable at S3; test the complete view in staging.

StaffAuditLog stores actorId/role/action/reportId/targetUserId/contentId-or-s3Key,
fixed reason `case_review`, and timestamp. No URLs, tokens, report note or snapshot
text. Action entries before transactions are explicitly named `*_attempt:*`;
ReportTransitions is the committed action/note journal. The application audit
service exposes append only; it cannot update/delete audit rows. Case viewers
never query audit records through this insert-only connection.

Receipts/outcomes/policy notices are in-app only, from sender=null, with no push
or participant socket payload. Reporter outcomes say only `Action taken` or
`No violation found`; reported users receive a generic policy notice only when
action is taken, with no case/reporter identity. `/reports/notices` includes these
system notices and Android's My reports screen renders notices without case IDs.

### Staff audit database principal and deployment runbook

No database users, indexes or AWS policies were applied by this change. An operator
must back up the database and perform these steps using separate migration credentials:

1. Keep MOD_API_ENABLED=off; deploy the role-hierarchy fix together with the moderator
   enum, after reviewing existing roles for unknown values. Never seed a moderator
   by granting admin. Existing root appoints lower staff through authorized routes.
2. Run the report-index script in `--report` mode, resolve duplicates, then `--apply`
   before code cutover. Phase 3 adds `ReportTransitions(reportId, createdAt)` with
   no TTL. Create StaffAuditLog and its report/time index using migration credentials.
3. In the intended database, create a custom role with ONLY insert on StaffAuditLog
   and a user with ONLY that custom role (illustrative mongosh commands, not run):

```javascript
use darkfantasy
db.createRole({ role: "staffAuditInsertOnly", privileges: [
  { resource: { db: "darkfantasy", collection: "StaffAuditLog" }, actions: ["insert"] }
], roles: [] })
db.createUser({ user: "staff_audit_writer", pwd: passwordPrompt(),
  roles: [{ role: "staffAuditInsertOnly", db: "darkfantasy" }] })
```

4. Supply that user's URI as STAFF_AUDIT_DATABASE_URL through the deployment secret
   store, never git/Expo. Verify insert succeeds while find/update/delete/drop fail.
   Do not grant readWrite/dbOwner, inherited broad roles, collection admin or schema
   migration rights. The runtime's main DB credential must likewise have no
   update/delete/drop privileges on StaffAuditLog; replace broad database-level
   grants with per-collection grants. Phase 2's system escalation needs insert on
   that collection. Audit retention/export is a separate controlled operator job.
5. Integrate the trusted staff MFA token exchange, verify issuer/amr and <=900s
   lifetime end-to-end, and rotate/drain old staff sessions. Set the four required
   staff settings, then MOD_API_ENABLED=on on a staging canary. Missing configuration
   must fail startup; a password-only or stale-role token must fail /mod authorization.
6. Verify queue/detail, restricted isolation, real audit-before-view failure denial,
   no-store/60s URL expiry, and the inline stream through the real proxy. Ensure
   reverse proxies and APM do not log response bodies, authorization or signed URLs.
   HTTP access logs intentionally contain only method/path/status/duration.
7. Verify demotion/suspension and account-room disconnect across every backend
   instance with the production Socket.IO adapter. Observe preservation/copy metrics.
   Keep REPORT_EVIDENCE_COPY off until its separate IAM/canary checklist passes.
8. Enable production only after those checks and owner/legal inputs are complete.
   Roll back moderation access by setting MOD_API_ENABLED=off and restarting all
   instances; preserve case/audit collections, image holds and durable jobs.

The gate recovery script is operator-only, not an API. It requires both the
observed expired token and `--holder-stopped`; successful recovery emits
`report_gate_operator_recovery count=1`. The CLI logs denied/failed attempts without
tokens. Keep operator command/terminal access restricted. Stop the old holder and
settle its storage requests before recovery; expiry alone is insufficient.

### Staff console requirements (implementation out of scope)

Require MFA and short staff sessions; blur every evidence image until explicit
click-to-reveal, never preload restricted images, and discard bytes on close,
logout or background. Escape report/snapshot/transition text on output; never
render HTML or autoload links. Require a case ID and reason for every image view,
obtain a fresh audited view per reveal, and handle pending-copy/audit failure as
denials. Restricted screens are admin/root only and have no save, download,
share or export controls. No vault traversal. Show revisions/conflicts and require
notes for every action. Add process controls for reviewer wellbeing, access review
and incident escalation. No console was added to Android.

## Owner-supplied release inputs and open legal questions

- Published content/community policy URL and Terms URL, acceptance wording/version
  and the point at which acceptance is required before uploading UGC.
- Trusted staff MFA issuer/token exchange, signing-secret ownership/rotation,
  staff roster and role approvers, production staff token lifetime, insert-only
  audit credentials, and the operator responsible for audit access reviews.
- Grievance officer name, contact email/address, complaint channel and escalation
  owner; child-safety point of contact and public child-safety standards URL.
- India counsel: applicable IT Rules/intermediary classification; grievance,
  takedown, preservation and response duties/deadlines under current law.
- POCSO: what triggers mandatory reporting, who performs it, which authority is
  contacted, required timing, and the documented manual escalation procedure.
- Difference between an underage-account allegation and suspected child sexual
  abuse material; how to scope immediate hiding and authorized review.
- Whether/how suspected material may be copied, its approved separate storage
  boundary, encryption/access controls, viewing restrictions and evidence handling.
- Minimum/maximum retention for each case type, unresolved cases, account deletion,
  legal holds, all object versions, backups and destruction authorization. Is the
  proposed 90-day resolved retention lawful for each category?
- Approved evidence context scope, handling of view-once/revoked media, chain of
  custody, access audit retention and designated admin staff.

Reporting/blocking code does not by itself complete Google Play's UGC and dating
child-safety requirements. Public policies, terms acceptance, an operational
moderation process, age safeguards and Play Console declarations/contacts also
need owner review. These inputs remain required before release.

## Phase 2 verification results

Evidence paths below are relative to the backend. Test names are exact Jest names
(parameterized placeholders expand into post/event/media or the fixture user ID).

| Requested check | Implementation evidence | Proving test |
| --- | --- | --- |
| 1. Deletion privacy | `src/reports/preservation.ts:84`; `src/chats/chats.service.ts:324`, `:467`; `src/posts/posts.controller.ts:270`; `src/events/events.controller.ts:238`. Existing authorization still applies; a hold alone never changes its result. | `src/reports/reports.integration.spec.ts:952`: `returns byte-identical HTTP success for %s deletion with or without a hold`; `:981`: `emits identical messageDeleted socket payloads with and without a hold and removes user-visible history`. |
| 2. Expired gate/retries | `src/reports/preservation.ts:8`, `:71`; `src/photos/photos.service.ts:664`, `:686`; `scripts/recover-report-gate.ts:7`. Expiry alerts; only a stopped-holder operator can recover, never automatic takeover. | `src/reports/reports.integration.spec.ts:1030`: `alerts on expired gate and retries durable cleanup/account purge after explicit fenced recovery`; `:1069`: `creates a renewable lease and refuses recovery of a live holder`. |
| 3. Account deletion | `src/photos/photos.service.ts:842`, `:907`: held keys become durable jobs while ordinary source/account rows are deleted. Cases/snapshots/audit are retained under the case retention policy. | `src/reports/reports.integration.spec.ts:998`: `purges non-evidence account data on schedule for target or reporter %s without stalling`; `:528`: `keeps copied evidence independent of a later sender delete/revoke and never purges cases with the account`. |
| 4. Profile snapshot | `src/reports/evidence-reader.ts:201`, `:214`: original avatar key + bio snapshot; image job/hold are in the intake transaction. | `src/reports/reports.integration.spec.ts:1010`: `keeps the original profile bio and photo snapshot after edits, replacement cleanup and account purge`. |
| 5. Missing historical membership | `src/reports/evidence-reader.ts:77`: generic 403 without source/member IDs. | `src/reports/reports.integration.spec.ts:1022`: `returns a generic prior-access error without leaking the group or membership history`. |
| 6. Free text/logging | `src/reports/report-input.ts:54`; `src/reports/reports.service.ts:342`, `:352`, `:368`; `src/common/middlewares/api-logger.middleware.ts:7`: escape notes, omit them from user APIs/logs, strip query strings; database intake failures become static 503 errors. | `src/reports/reports.integration.spec.ts:1055`: `emits counts only and never logs or returns report text, image keys or signed URLs`; `:1077`: `redacts failed report documents from HTTP driver errors`. |
| 7. Counts | `src/reports/reports.service.ts:28`: minute count-only structured log of distinct active resource IDs and pending image jobs (ordinary + restricted). | `src/reports/reports.integration.spec.ts:1055`: `emits counts only and never logs or returns report text, image keys or signed URLs`. |
| 8. Copy enablement | Safe operator steps under Phase 2 verification operations above; `src/reports/reports.service.ts:392` gates worker execution. Real AWS canary remains operator work. | `src/reports/reports.integration.spec.ts:384`: `stores pending image jobs while off, retries idempotently when on, and keeps the source hold`; `src/reports/reports.security.spec.ts:45`: `copies evidence server-side with replaced metadata, private encryption and no-store; generic signing refuses reports`. |

- Backend and Expo typechecks passed.
- Full backend suite on a disposable replica set: 27 suites, 242 tests passed,
  none skipped, including the existing vault/chat/block regressions.
- Frontend contract/state suite: 103 tests passed, none skipped.
- Backend replay: `rtk proxy node scripts/test-with-mongo.cjs <absolute-module-path-to-mongodb-memory-server> --silent`.
- Frontend replay from the Expo root:
  `rtk proxy node --test scripts/test-auth.cjs scripts/test-vault.cjs scripts/test-dev-api-proxy.cjs scripts/test-events.cjs scripts/test-blocks.cjs scripts/test-reports.cjs`.
- Android device checklist, real S3/IAM/lifecycle checks and a multi-node Socket.IO
  deployment test remain pending owner execution. No application database,
  production index or AWS configuration was changed.

## Phase 3 verification evidence

Paths are relative to the backend. `M` below means
`src/reports/mod.integration.spec.ts`; `R` means
`src/reports/reports.integration.spec.ts`; `S` means
`src/reports/mod.security.spec.ts`. Test names are exact, with parameterized
placeholders expanded by Jest. All application changes preserve existing
owner-only vault authorization and the distinction between UserBlocks and
administrative Users.isBlocked.

| Claim | File:line evidence | Test name and location |
| --- | --- | --- |
| Quick check (a): identical socket success ack/error shape | `src/chats/chats.gateway.ts:300`, `:417`; `src/reports/preservation.ts:85`. Success returns undefined; failed ownership lookup emits `error` with statusCode=404 and message="Message not found", regardless of holds. | R:1089 `keeps message-delete ack and error shapes identical with and without a preservation hold`; R:981 `emits identical messageDeleted socket payloads with and without a hold and removes user-visible history`. |
| Quick check (b): held purge keys survive every unresolved/restricted/held state | `src/photos/photos.service.ts:847` queues held keys; `:716` defers in-use deletion; `src/reports/reports.service.ts:457` only retains resolved actioned/dismissed candidates and rechecks legal/restricted/pending state before releasing holds. | R:1105 `does not delete held account-purge bytes for %s cases` (open/escalated/restricted/legalHold); M:344 `never releases an escalated hold even if stale resolution metadata is present`. |
| Operator recovery: token, stopped holder, logged use, no API | `scripts/recover-report-gate.ts:8`; `src/reports/preservation.ts:71`. Script validates arguments before connecting; recovery compares exact expired token and logs a static metric. | R:1030 `alerts on expired gate and retries durable cleanup/account purge after explicit fenced recovery`; M:314 `denies evidence on real audit insert failure and exposes no audit mutation or gate-recovery route`. |
| Role hierarchy and enum validation | `src/users/role-policy.ts:15`, `:20`, `:29`; `src/users/users.service.ts:66`; `src/common/schemas/users.schema.ts:94`. Existing staff create/update routes pass verified actor ID. | M:112 `enforces role hierarchy, rejects self role changes and validates every role enum item`; M:128 `protects the last active root under serialized concurrent demotions`. |
| Last root also protected from legacy account paths | `src/users/role-policy.ts:6`; `src/users/users.service.ts:574`; `src/photos/photos.service.ts:539`. | M:351 `protects the last root from legacy admin block/update and self account deletion`. |
| Feature default off; production refuses unsafe enablement | `src/reports/mod.guard.ts:6`, `:7`, `:17`; `src/reports/staff-audit.service.ts:9`; `.env.example` explicitly defaults off. | M:98 `returns the nonexistent-route response when disabled, before authentication`; M:257 `refuses production enablement without MFA, short tokens and a dedicated audit credential`. |
| MFA claims and short staff lifetime enforced, password login does not claim MFA | `src/reports/mod.guard.ts:39`; `src/auth/auth.service.ts:38`. | M:269 `requires an MFA-authenticated short staff token in production rather than trusting a configuration flag`; M:284 `issues short staff tokens without falsely asserting MFA`. |
| RolesGuard matrix on every /mod endpoint, fresh roles and demotion | `src/reports/mod.controller.ts:9`; `src/common/guards/jwt.strategy.ts:23`; `src/reports/mod.guard.ts:30`. | M:85 `RolesGuard /mod matrix %s -> %s` (anonymous/user/manager/moderator/admin/root; all eight endpoint shapes); M:106 `uses DB roles despite forged/stale token roles and demotion applies on the next request`. |
| Pair-block exemption grants no foreign vault authority | `src/reports/mod.guard.ts:46`; `src/reports/mod.service.ts:22` raw case access; `src/vault/vault.controller.ts:25` derives owner from JWT. | M:138 `keeps /mod independent of pair blocks without granting another-user vault access`; existing vault security suite remains unchanged. |
| Queue, detail, review queue and assignment | `src/reports/mod.service.ts:31`, `:37`, `:52`, `:80`; `src/reports/mod.controller.ts:14`. Returned cases omit reporterId and storage keys; snapshots are escaped. | M:85 route matrix; M:335 `assigns cases with revisions and legal holds only to authorized staff`; M:138 verifies escaped detail and no reporterId. |
| Mandatory notes, valid transitions and atomic concurrency | `src/reports/mod-input.ts:5`; `src/reports/mod.service.ts:80`, `:108`; conditional revision update + transaction journal/status/action/notices. | M:151 `requires notes, enforces transitions and serializes concurrent case revisions atomically`. |
| Restricted admin/root-only streams, no signing/download/export | `src/reports/mod.service.ts:18`, `:61`; `src/reports/mod.controller.ts:29`; `src/common/interceptors/response.Interceptor.ts:28`; `src/photos/response.interceptor.ts:17`. | M:161 `requires admin/root for restricted cases, assignment, streams and legal holds; never signs restricted bytes`. |
| Case-bound ordinary evidence, audit before view, <=60s/no-store | `src/reports/mod.service.ts:61`; `src/s3-bucket/s3-bucket.service.ts:275`; no user-supplied storage key. | M:184 `writes the case audit before issuing a <=60 second ordinary evidence URL and denies on audit failure`; S:7 `signs only ordinary case evidence for sixty seconds with no-store and inline disposition`. |
| Append-only application audit and failure denial | `src/reports/staff-audit.service.ts:18`; dedicated insert-only principal runbook above. No update/delete method, URL/token/text fields, or audit mutation route. | S:21 `provides only append, commits audit before return and converts insert failures to denial`; M:314 tests actual MongoDB audit-insert failure through HTTP. Real production principal grants remain operator verification. |
| Soft removal, held cleanup, eventual deletion after retention | `src/reports/mod.service.ts:135`; `src/photos/photos.service.ts:783`. | M:204 `soft-removes content immediately and durable cleanup preserves held bytes` also verifies the same job deletes source bytes after retention releases its hold. |
| Escalation stays unresolved; permanent actions/legal hold admin-only | `src/reports/mod.service.ts:85`, `:112`; `src/reports/mod.controller.ts:26`. | M:219 `keeps escalation unresolved until admin acts and denies moderator permanent actions and legal hold`; M:328 `allows admin permanent %s actions`; M:335 assignment/legal-hold revisions test. |
| Suspension distinct from isBlocked; auth denial, expiry and all-device disconnect | `src/common/guards/jwt.strategy.ts:35`; `src/photos/photos.service.ts:52`; `src/chats/chats.gateway.ts:57`; `src/user-blocks/block.service.ts:59`. | M:230 `enforces temporary suspension in HTTP authentication and all-device socket disconnect`; M:290 `denies suspended accounts at password authentication and at socket packet authentication`; M:300 `replicates suspension disconnect signals to other backend watchers`. |
| Reporter isolation and in-app-only system notices | `src/reports/mod.service.ts:27`, `:150`, `:163`; `src/reports/reports.service.ts:368`; `src/features/safety/MyReportsScreen.tsx` in Expo renders optional case IDs safely. No push call or participant notification socket event. | M:243 `isolates reporters in case APIs and in-app system-only outcome/policy notices`; R:775 existing participant/socket isolation test. Frontend `each role has confirmed capabilities; unknown roles fail closed` now includes moderator without Android admin tools. |

Production MFA integration, real AWS/IAM evidence-view canary, insert-only DB grant
verification, Android device execution and an actual multi-instance Socket.IO
adapter deployment remain operator tasks. The API/role checks, private streaming,
preservation and regression tests use the disposable replica set and mocked S3;
no application data, production indexes, database principals or AWS settings were changed.

Final Phase 3 validation: backend and Expo typechecks passed; full backend suite
on the disposable replica set passed **29 suites / 278 tests**, none skipped,
including vault/chat/block/report regressions. Frontend contract/state tests passed
**103 tests**, none skipped. `git diff --check` passed. MOD_API_ENABLED and
REPORT_EVIDENCE_COPY remain off by default; no production configuration was enabled.

## Phase 3 verification audit (latest)

This audit fixes conflict-of-interest exclusion for staff reporters/assignees,
case-insensitive ObjectId self-change checks, transaction-scoped root/actor reads
and explicit majority role commits. Account self-deletion now commits its purge
job, account restriction and upload state in one transaction, so a failed account
write cannot strand a pending purge behind an otherwise active-looking root.
No new MFA implementation, console, external service or AWS deployment was added.

### Trusted MFA contract and separate TOTP proposal — NOT IMPLEMENTED

Current verification order is: JwtAuthGuard invokes Passport JWT verification
(`src/common/guards/jwt.strategy.ts:15`): HS256 signature using server JWT_SECRET,
normal expiry validation, then sub is resolved against current Users and purge
state. It copies only iat/exp/amr/iss into internal staffClaims. RolesGuard checks
the DB-backed roles; ModCaseGuard re-reads Users before permitting /mod. In
production it requires `iss === STAFF_MFA_ISSUER`, an **array** amr containing the
literal `mfa`, finite iat/exp, exp greater than iat, iat no more than 30 seconds in
the future, and token lifetime/age within STAFF_TOKEN_TTL_SECONDS (60–900 seconds).
No audience, auth_time, TOTP secret or separate MFA-verification timestamp is
currently checked. The trusted issuer must perform both factors just before
issuing this token; it must not attach mfa to a silent password-only refresh or
reissue a fresh iat indefinitely after an old MFA event. The issuer must be
trusted to sign with the configured server secret; an arbitrary third-party
OIDC/JWKS token is NOT accepted by this verifier. Role claims never grant staff
authority. Do not distribute JWT_SECRET to an untrusted issuer or client.

Current step-up behavior is **denial**, not an implemented challenge endpoint:
password-only staff JWTs can serve ordinary app requests but receive 403 from
production /mod. A trusted, separately integrated MFA flow must return a new,
short signed token with those claims; the caller then retries its explicit staff
request. Expired JWTs receive 401 at Passport; suspended/demoted accounts remain
denied even with previously valid MFA claims. No TOTP enrollment/verification,
MFA token exchange, challenge UI or recovery endpoints exist. Tests at
`mod.integration.spec.ts` named `requires an MFA-authenticated short staff token
in production rather than trusting a configuration flag` and `issues short staff
tokens without falsely asserting MFA` prove the current boundary, not a live MFA
integration. Keep MOD_API_ENABLED off until the integration is completed.

Separate implementation plan, requiring a new approved task:

1. Add a dedicated staff MFA record (user ID, encrypted per-user TOTP secret,
   enrollment state/version, last accepted time step, hashed single-use recovery
   codes). Use a server-managed encryption key in the deployment secret store,
   separate from JWT signing; never log OTPs, secrets or provisioning URIs.
2. Require fresh password authentication and current DB staff role before enrollment.
   Generate a random secret and an expiring pending enrollment; show its QR once
   over HTTPS/no-store. Activate only after a valid authenticator code. Choose
   interoperable six-digit TOTP with a 30-second step and a narrow ±1-step drift
   window, using a maintained RFC 6238 implementation selected/pinned at that time.
   Test RFC vectors, drift boundaries and replay rejection; never hand-roll crypto.
3. Proposed endpoints: `/auth/staff/mfa/enroll`, `/confirm`, `/challenge`, `/verify`
   and controlled `/recover` (none exist today). Challenges last five minutes and
   bind verified user/session ID and nonce, never a caller-supplied identity. Apply
   shared per-account/per-IP attempt limits, generic errors and bounded lockouts.
   Consume challenge + accepted time step atomically so parallel/replayed OTPs fail.
4. Only successful password + OTP/recovery verification can mint the current
   `amr:["pwd","otp","mfa"]`, configured issuer and <=900-second token. No automatic
   background step-up or silent retry of a destructive action. The future console
   prompts on 403, obtains the token and lets the reviewer explicitly retry.
   Add a server-checked MFA authentication timestamp and session/MFA version when
   implementing this, so token renewal cannot extend the original step-up forever.
5. Generate recovery codes once, store only strong hashes, and consume atomically.
   MFA disable/reset requires reauthentication or a documented staff-controlled
   recovery process, invalidates old MFA sessions and emits an audit/security notice.
   Protect the last-root recovery path from lockout; do not make email-only reset
   a shortcut around MFA. Log security event IDs/outcomes, never credential values.
6. Add enrollment/replay/rate-limit/recovery/session-expiry tests and real-device
   authenticator + staff-browser acceptance. Roll out with MOD_API_ENABLED off,
   confirm real issuer/claims/revocation in staging, then follow the checklist below.

The TOTP algorithm/time-step/random-secret basis comes from
[RFC 6238](https://www.rfc-editor.org/rfc/rfc6238). Factor enrollment, recovery,
reauthentication and reset controls should follow the
[OWASP MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html).
TOTP is phishable; this is a proposal for the smallest implementation, not a claim
that it provides phishing-resistant staff authentication.

### Single pre-production checklist — all pending operator/owner work

This checklist consolidates prior rollout sections; none of these production
operations were run by the audit. Use staging first and record evidence/owner for
each item. Keep MOD_API_ENABLED=off and REPORT_EVIDENCE_COPY=off during preparation.

- [ ] **Backup, root access and topology:** verify a recoverable DB backup, restore
  rehearsal, existing valid root accounts and a restricted operator credential.
  Use a MongoDB replica set/sharded topology with logical sessions, transactions,
  majority commits and change streams. Standalone MongoDB must fail startup; do
  not bypass block-startup.ts. Preserve existing Docker data volumes when converting
  local development topology. A local authenticated ping alone is insufficient.
- [ ] **Prepare artifact and index maintenance:** drain old destructive/report writers;
  do not run mixed releases that ignore preservation holds. Confirm existing
  photo/vault storage indexes first (`src/photos/storage-indexes.ts`, explicit
  `storageIndexes(connection, false)` report then `true` apply using the controlled
  migration credential). PHOTO_STORAGE_INDEXES=report/apply is the existing opt-in;
  there is no dedicated standalone storage-index CLI. Do not expose an API boot
  to public traffic just to create indexes. Resolve/approve duplicate handling
  and verify owner/slot, upload idempotency, cleanup/purge indexes.
- [ ] **Block indexes first:** from the backend with DATABASE_URL/DATABASE_NAME set
  privately, run `rtk proxy npx ts-node scripts/user-block-indexes.ts --report`,
  resolve duplicates, then the same script with `--apply`. Verify deterministic
  primary keys, unique blocker/blocked pair and reverse blockedId index.
- [ ] **Report indexes second:** run
  `rtk proxy npx ts-node scripts/report-indexes.ts --report`, resolve open-case
  duplicates, then `--apply`. This also creates hold/job/access, audit case/time and
  ReportTransitions indexes. Verify the partial open-report unique index. Never
  add evidence/hold TTLs. All reviewed indexes must exist **before code cutover**;
  runtime USER_BLOCK_INDEXES and REPORT_INDEXES can remain off afterward.
- [ ] **Audit principals and role data:** create StaffAuditLog/indexes with migration
  credentials, then the documented insert-only audit role/user. Verify insert
  succeeds and find/update/delete/drop fail using that principal. Remove broad
  grants from the main runtime principal that would allow audit mutation. Store
  STAFF_AUDIT_DATABASE_URL privately. Audit existing Users.roles values; resolve
  invalid legacy values and deploy hierarchy + moderator enum together. Verify
  last-root/self-change protection and an independent staff recovery procedure.
- [ ] **Deploy held deletion/retention code before reports:** ensure every delete,
  revoke, expiry, account-purge and durable cleanup worker understands holds;
  verify transaction rollback and expired-gate alerts. Assign the operator for
  token-checked stopped-holder recovery and preservation/copy backlog monitoring.
  Legal-hold/status changes must use the gate. No age-only source/evidence expiry.
- [ ] **Multiple backend instances:** install/configure a compatible Socket.IO
  adapter (e.g. Redis), adapter credentials and TLS, load-balancer upgrades/timeouts,
  and sticky sessions when HTTP polling is used. Implement/verify aggregate presence
  across instances; an adapter alone does not fix process-local socket counts.
  Test block, reconnect, removed-group-member eviction, demotion and suspension
  across all devices/instances. Verify change-stream privileges and recovery.
- [ ] **Review/apply IAM and lifecycle diffs separately:** review the Phase 2 copy/
  retention permissions and Phase 3 private reports/ GetObject delta above. Preserve
  public-access blocking, TLS, encryption and generic signing refusal. Remove or
  scope source/report/version lifecycle deletions that cannot honor DB holds.
  Configure no restricted-evidence prefix or grant before legal approval. Verify
  bucket routing and all object-version handling; no AWS changes were applied here.
- [ ] **Enable ordinary evidence copying safely:** while off, file a consenting
  staging image report and verify case/text/hold/copy_pending. Inspect backlog
  before turning REPORT_EVIDENCE_COPY=on for one canary: the worker processes all
  due ordinary jobs, not one selected case. Verify destination bytes/checksum,
  private access, replaced metadata, encryption, no-store and copied job/snapshot
  state. Delete/revoke source and verify evidence persists. Enable other workers
  and observe bounded retries/drain (up to 20 jobs/minute/worker under the shared
  gate); restricted_pending_legal must stay pending. If checks fail, turn off the
  flag, retain jobs/holds and repair permissions—never release holds to drain jobs.
- [ ] **Trusted MFA and MOD_API_ENABLED:** complete the separately approved trusted
  issuer/step-up integration; supply STAFF_MFA_ENABLED=on, STAFF_MFA_ISSUER, a
  60–900-second STAFF_TOKEN_TTL_SECONDS and the insert-only audit URI. Test refusal
  of incomplete production configuration, password-only/expired/stale-role tokens,
  MFA claim validation and demotion/suspension on the next request. Review staff
  roster/least privilege. Enable MOD_API_ENABLED only on a staging canary first;
  confirm audit-majority-before-view, real <=60s/no-store URLs and admin-only inline
  restricted viewing through the production proxy. Flags alone are not MFA.
- [ ] **Staff console and observability:** provide the separately built console
  with blur/click-to-reveal, escaped text, explicit case-bound views/notes, conflict
  handling, no restricted save/download/export, session clearing and no vault
  traversal. Verify no proxy/APM/browser analytics log bodies, signed URLs, tokens
  or OTPs. Connect expired-gate, held-source and pending-copy metrics to alerts;
  name responsible responders and document rollback (flags off, preserve evidence).
- [ ] **Android device pass:** execute the existing block/report manual checklists
  on physical Android: profile/header/long-press block, list/unblock, cache purge,
  collapsed group messages/media denial, offline error + memory-only draft,
  category/note/double-submit behavior, image/profile/post report entry points,
  post-block/former-member reports, My reports receipt/outcome and system-policy
  notices without case IDs. Test old JWT rejection and expiry/reconnect. Record
  device/OS/build and pass/fail; automated frontend tests do not replace this.
- [ ] **Owner policy/contact inputs:** supply published content policy, Terms and
  child-safety standards URLs; terms-acceptance wording/version and upload gating;
  grievance officer name/contact/address and public email; child-safety contact;
  operational moderator/admin roster, appeal/escalation process, complaint SLA
  owner, and applicable Play Console declarations/age safeguards.
- [ ] **Legal approval before release:** obtain India counsel's answers for IT
  Rules/intermediary classification and grievance/takedown/preservation deadlines;
  POCSO reporting trigger, responsible person, authority, timing and manual process;
  distinguish underage allegations from suspected abuse material; approve who may
  view it, storage boundary/encryption, copying/view-only procedure, context scope,
  chain of custody, unresolved/restricted/resolved retention (90-day default remains
  pending), legal holds, account deletion, backups/versions and destruction. No
  external reporting integration or restricted storage design is finalized.
- [ ] **Final release decision:** record actual staging evidence for the above,
  both typechecks/full replica-set/backend and frontend regressions, real AWS and
  multi-instance tests, root recovery and Android pass. Only then enable production
  staff APIs/copying with approved settings. Roll back access with flags off while
  keeping cases, audit rows, holds and jobs intact.

### Verification audit evidence by requested item

All paths below are backend-relative. `M` denotes
`src/reports/mod.integration.spec.ts`. These tests ran against a disposable
replica set; storage calls were mocked. No production mutation was performed.

| Item | File:line and finding | Exact proving test name |
| --- | --- | --- |
| 1. Role/deletion concurrency | `src/users/role-policy.ts:29` rejects self changes using ObjectId equality; `:37` snapshots target, actor and active-root checks in one transaction, `:44` explicitly majority-commits it. `src/reports/preservation.ts:11` serializes all instances through a token-owned MongoDB gate. `src/photos/photos.service.ts:539`, `:555` use the same gate and atomic majority transaction for self-deletion. Admin-to-admin demotion is forbidden for both callers. Cross-root demotions or root-demotion/self-delete races leave one active root; partial self-deletion writes roll back. | M:359 `rejects both concurrent admin-on-admin demotions and concurrent last-root self changes`; M:370 `serializes root removals across independent database connections`; M:381 `keeps an active root when a role change races self deletion (delete first=%s)` (both orders); M:489 `rolls back purge scheduling if the root account write fails, leaving no unavailable root counted as active`. M:112 also tests uppercase self ID rejection. |
| 2. Audit-before-view | `src/reports/mod.service.ts:70` awaits restricted audit before `:71` reads bytes; `:76` awaits ordinary audit before `:77` signs. `src/reports/staff-audit.service.ts:20` awaits insertOne with `writeConcern:{w:'majority'}` at `:22`; insert failure becomes 503. The controller cannot construct its StreamableFile until service completion. | M:410 `acknowledges audit before evidence and returns no URL or bytes on failed audit (restricted=%s)` for both paths: the storage callback observes the inserted row; real MongoDB validation failure produces JSON 503 with zero signing/read calls. `src/reports/mod.security.spec.ts:21` `provides only append, commits audit before return and converts insert failures to denial` asserts majority options. |
| 3. Feature off indistinguishable from absent routes | `src/reports/mod.guard.ts:17` executes before authentication and raises the same missing-route message/method/original URL. Test uses a separate empty Nest app at the exact same method/path/query, not rewritten expected JSON. | M:391 `compares disabled routes byte-for-byte with an app having no mod routes for %s`: anonymous/user/moderator/admin, all eight route shapes including a query string; status=404 and response text match exactly. |
| 4. Suspension and natural expiry | `src/common/guards/jwt.strategy.ts:35` checks the current deadline; `src/photos/photos.service.ts:59` enforces it for socket account authorization. `src/chats/chats.gateway.ts:57` disconnects the whole account room; per-packet authentication rechecks it. No worker has to clear the deadline for automatic expiry. | M:431 `rejects the same existing JWT on suspension and accepts it after time-based expiry without changing the stored deadline`; M:230 `enforces temporary suspension in HTTP authentication and all-device socket disconnect`; M:290 `denies suspended accounts at password authentication and at socket packet authentication`; M:300 `replicates suspension disconnect signals to other backend watchers`. |
| 5. Conflict of interest | Fixed missing reporter exclusion. `src/reports/mod.service.ts:20` excludes reporter and target in the raw case/list query; `:53` excludes involved owners from aggregate review queue; `:96` normalizes assignee IDs and `:97` rejects reporter/target assignment. The common case loader protects reads, evidence and every mutation before audit/storage work. Even admin/root has no override. | M:444 `excludes a staff reporter or target from every case operation and assignment (%s/%s)` covers reporter/target x moderator/admin/root, list/review/detail/evidence/assignment/status/action/legal hold, uppercase assignee IDs and zero audit/storage side effects. |
| 6. Restricted existence/list isolation | `src/reports/mod.service.ts:20`, `:23`, `:32` apply the restricted predicate before sorting/limit; `:53` filters the review queue before its limit. API has no unfiltered total/count field. Restricted lookup uses the same `Case not found` response as absent content. Moderator legal-hold access is 403 for either case because role authorization occurs first. | M:461 `makes restricted and nonexistent cases identical across routes and query-level pagination`: exact status/text match on all case route shapes; 55 visible + 60 restricted cases produce 50/5 visible pages, and deleting restricted rows changes neither returned data nor cursor. Review-queue output likewise stays identical. |
| 7. Trusted MFA and TOTP proposal | `src/common/guards/jwt.strategy.ts:15`, `:40` verify signature/expiry and copy claims; `src/reports/mod.guard.ts:36` verifies production MFA/issuer/lifetime requirements. The separate proposal above contains enrollment, storage, challenge/recovery, tests and rollout, with no implemented TOTP routes. | M:269 `requires an MFA-authenticated short staff token in production rather than trusting a configuration flag`; M:284 `issues short staff tokens without falsely asserting MFA`. **TOTP implementation tests: NOT FOUND**, intentionally not implemented by this audit. |
| 8. Unified pre-production gate | The single checklist above supersedes scattered rollout lists as the release sign-off: topology, index order, adapter/presence, audit principal, IAM/lifecycle, copy canary/drain, MFA/flags, Android, policies/contacts/legal input and rollback. | Operator/documentation checklist, not an executable test. Its automated prerequisites are covered by items 1–7 and the full regressions; real AWS, production DB grants, multi-instance deployment, Android and legal approval remain pending. |

Latest audit validation: both backend and Expo typechecks passed; the full backend
run passed **29 suites / 297 tests**, none skipped, including vault/chat/block/report
regressions. A final targeted run of the changed moderation suite passed **48 tests**,
including ObjectId-casing regressions. Frontend tests passed **103 tests**, none
skipped. `git diff --check` passed. Preserve MOD_API_ENABLED=off and
REPORT_EVIDENCE_COPY=off until operator/owner sign-off. No AWS changes, application
database writes, production index operations, or MFA implementation were performed.
