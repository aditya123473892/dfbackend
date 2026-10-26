import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ClientSession, Connection, Types } from 'mongoose';
import { createHash } from 'crypto';
import { S3BucketService } from '../s3-bucket/s3-bucket.service';
import { ReportInput } from './report-input';

export async function recordReportAccess(
  db: Connection,
  viewerId: string,
  collection: string,
  id: string,
  session?: ClientSession,
) {
  if (!db?.getClient || !Types.ObjectId.isValid(viewerId)) return;
  if (!['Users', 'Posts', 'Events'].includes(collection)) return;
  const resource = `${collection}:${id}`;
  await db.db.collection<any>('ReportAccess').updateOne(
    { _id: `${viewerId}:${resource}` },
    {
      $setOnInsert: { viewerId, resource, firstSeenAt: new Date() },
      $set: { lastSeenAt: new Date() },
    },
    { upsert: true, session },
  );
}
/** Internal-only reader. No controller/provider export, no signing/history calls,
 * no Mongoose queries and no caller-supplied owner/conversation/authorization. */
export async function readReportSource(
  db: Connection,
  storage: S3BucketService,
  reporter: string,
  input: ReportInput,
  session: ClientSession,
) {
  const oid = (id: string) => new Types.ObjectId(id);
  const one = (collection: string, filter: any) =>
    db.db.collection<any>(collection).findOne(filter, { session });
  const collection = {
    user: 'Users',
    post: 'Posts',
    comment: 'Comments',
    event: 'Events',
    group: 'Groups',
    chat_message: 'ChatMessages',
    chat_media: 'ChatMessages',
  }[input.targetType];
  const sourceId =
    input.targetType === 'chat_media' ? input.messageId : input.targetId;
  const source = await one(collection, { _id: oid(sourceId) });
  if (!source) throw new NotFoundException('Reported content is unavailable');
  const owner = String(
    source.user ||
      source.creator ||
      source.admin ||
      source.sender ||
      source._id,
  );
  if (owner === reporter)
    throw new ForbiddenException('You cannot report your own content');
  let conversationId: string | undefined,
    context: any[] = [],
    selectedMedia: any[] | undefined;
  if (collection === 'ChatMessages') {
    if (source.groupId) {
      const group = await one('Groups', { _id: oid(String(source.groupId)) });
      const former = await one('ReportMemberships', {
        _id: `${source.groupId}:${reporter}`,
      });
      const current = group?.members?.some((id) => String(id) === reporter);
      if (
        !current &&
        !(
          former &&
          (!former.leftAt ||
            new Date(source.sentAt || source.createdAt || 0) <= former.leftAt)
        )
      )
        throw new ForbiddenException('We could not verify your prior access to this conversation. Please contact support.');
      conversationId = `group:${source.groupId}`;
    } else {
      if (![String(source.sender), String(source.receiver)].includes(reporter))
        throw new ForbiddenException('We could not verify your prior access to this conversation. Please contact support.');
      conversationId = `direct:${[String(source.sender), String(source.receiver)].sort().join(':')}`;
    }
    const forms = (id: any) => ({ $in: [String(id), oid(String(id))] });
    const conversation = source.groupId
      ? { groupId: forms(source.groupId) }
      : {
          groupId: null,
          $or: [
            { sender: forms(source.sender), receiver: forms(source.receiver) },
            { sender: forms(source.receiver), receiver: forms(source.sender) },
          ],
        };
    const timestamp = source.sentAt || source.createdAt;
    const preceding = timestamp
      ? {
          $or: [
            { sentAt: { $lt: timestamp } },
            { sentAt: timestamp, _id: { $lt: source._id } },
          ],
        }
      : { _id: { $lt: source._id } };
    context = await db.db
      .collection<any>('ChatMessages')
      .find({ $and: [conversation, preceding] }, { session })
      .sort({ sentAt: -1, _id: -1 })
      .limit(20)
      .toArray();
    context.reverse();
    if (input.targetType === 'chat_media') {
      selectedMedia = (source.media || []).filter((media, index) => {
        const id =
          media._id && (media.storageKey || media.checksum)
            ? String(media._id)
            : createHash('sha256')
                .update(
                  `${source._id}:${media.filename || media.originalname || index}:${index}`,
                )
                .digest('hex')
                .slice(0, 24);
        return id === input.targetId;
      });
      if (!selectedMedia.length)
        throw new NotFoundException('Reported content is unavailable');
    }
  } else if (collection === 'Groups') {
    const former = await one('ReportMemberships', {
      _id: `${source._id}:${reporter}`,
    });
    if (!source.members?.some((id) => String(id) === reporter) && !former)
      throw new ForbiddenException('Prior group membership required');
  } else {
    // A comment is reportable exactly when its parent post is visible to the
    // reporter, and the comment itself is not hidden from them.
    const comment = collection === 'Comments';
    const parent = comment
      ? await one('Posts', { _id: oid(String(source.post)) })
      : source;
    if (!parent) throw new NotFoundException('Reported content is unavailable');
    const parentCollection = comment ? 'Posts' : collection;
    const parentOwner = comment ? String(parent.user) : owner;
    const owners = [...new Set([owner, parentOwner])];
    const receipt = await one('ReportAccess', {
      viewerId: reporter,
      resource: `${parentCollection}:${parent._id}`,
    });
    if (!receipt || comment) {
      const pair = await one('UserBlocks', {
        $or: owners.flatMap((id) => [
          { blockerId: oid(reporter), blockedId: oid(id) },
          { blockerId: oid(id), blockedId: oid(reporter) },
        ]),
      });
      const restricted = await one('RestrictedContent', {
        $or: [
          { _id: `${collection}:${sourceId}` },
          { _id: `${parentCollection}:${parent._id}` },
          ...owners.map((id) => ({ _id: `Users:${id}` })),
        ],
      });
      let visible =
        !pair && !source.deletedAt && !parent.deletedAt && !restricted;
      if (collection === 'Users')
        visible &&= !source.isBlocked && !source.deletionRequestedAt;
      // A prior-access receipt on the parent post stands in for these checks.
      if (parentCollection === 'Posts' && !receipt) {
        visible &&= parent.status === 'approved';
        if (parent.visibility === 'friends')
          visible &&= !!(await one('follows', {
            follower: oid(reporter),
            following: oid(parentOwner),
            status: 'accepted',
          }));
        else if (parent.visibility === 'private')
          visible &&= !!(await one('PostRequest', {
            userId: { $in: [parentOwner, oid(parentOwner)] },
            requestedUserId: { $in: [reporter, oid(reporter)] },
            status: 'accepted',
            startTime: { $lte: new Date() },
            endTime: { $gte: new Date() },
          }));
        else visible &&= parent.visibility === 'public';
      }
      if (!visible)
        throw new ForbiddenException('Verified prior access required');
    }
  }
  const rows = [...context, source];
  const resources = new Set<string>(),
    keys = new Set<string>();
  for (const row of rows) {
    resources.add(`${collection}:${row._id}`);
    const rowOwner = String(
      row.user || row.creator || row.admin || row.sender || row._id,
    );
    resources.add(`owner:${rowOwner}`);
    if (row.receiver) resources.add(`owner:${row.receiver}`);
    if (row.groupId) {
      resources.add(`Groups:${row.groupId}`);
      const group = await one('Groups', { _id: oid(String(row.groupId)) });
      if (group?.admin) resources.add(`owner:${group.admin}`);
    }
    const media =
      row === source && selectedMedia ? selectedMedia : row.media || [];
    for (const value of [
      row.avatar,
      row.groupIcon,
      row.cover?.storageKey,
      row.cover?.filename,
      row.cover?.url,
      ...media.map((item) => item.storageKey || item.filename || item.url),
    ]) {
      if (typeof value !== 'string') continue;
      const key = storage.keyFromReference(value);
      if (key && !/^(vault|temp|reports|quarantine)\//.test(key)) {
        keys.add(key);
        resources.add(`key:${key}`);
      }
    }
  }
  const snapshot = (row: any) => ({
    contentId: String(row._id),
    senderId: row.sender ? String(row.sender) : undefined,
    timestamp: row.sentAt || row.createdAt,
    message: row.message,
    content: row.content,
    caption: row.caption,
    displayname: row.displayname,
    bio: row.bio,
    // Immutable references; the matching objects remain protected by key holds.
    profilePhotos: collection === 'Users' && row.avatar
      ? [storage.keyFromReference(row.avatar)].filter(Boolean) : undefined,
    age: row.age,
    name: row.name,
    description: row.description,
    startAt: row.startAt,
    endAt: row.endAt,
    // Never snapshot passwords, phone numbers, tokens, roles or billing data.
  });
  return {
    collection,
    sourceId,
    owner,
    conversationId,
    messageId: collection === 'ChatMessages' ? String(source._id) : undefined,
    snapshot: snapshot(source),
    context: context.map(snapshot),
    resources: [...resources],
    keys: [...keys],
  };
}
