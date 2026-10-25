import { Connection, Types } from 'mongoose';
export async function restrictedResource(
  db: Connection,
  collection: string,
  id: string,
  ownerId?: string,
  groupId?: string,
) {
  if (!db?.getClient) return false;
  return !!(await db.db.collection('RestrictedContent').findOne(
    {
      $or: [
        { _id: `${collection}:${id}` },
        ...(ownerId ? [{ _id: `Users:${ownerId}` }] : []),
        ...(groupId ? [{ _id: `Groups:${groupId}` }] : []),
      ],
    } as any,
    { projection: { _id: 1 } },
  ));
}
export async function restrictionFilter(
  db: Connection,
  collection: string,
  rows?: any[],
) {
  const fields: Record<string, string[]> = {
    Users: ['_id'],
    Posts: ['user'],
    Events: ['creator'],
    Groups: ['admin'],
    ChatMessages: ['sender', 'receiver'],
    Comments: ['user'],
    Likes: ['user'],
    EventMembers: ['user'],
    PostBookMark: [],
    UserBookMark: ['bookMarkUser'],
    follows: ['follower', 'following'],
    PostRequest: ['userId', 'requestedUserId'],
    Notifications: ['sender'],
  };
  if (!db?.getClient || !fields[collection]) return {};
  rows ||= await db.db.collection('RestrictedContent').find({}).toArray();
  if (!rows.length) return {};
  const forms = (ids: string[]) =>
    ids.flatMap((id) =>
      Types.ObjectId.isValid(id) ? [id, new Types.ObjectId(id)] : [id],
    );
  const users = forms(
    rows
      .filter((row) => row.collection === 'Users')
      .map((row) => row.contentId),
  );
  const own = forms(
    rows
      .filter((row) => row.collection === collection)
      .map((row) => row.contentId),
  );
  const filters: any[] = [];
  if (own.length) filters.push({ _id: { $nin: own } });
  if (users.length)
    filters.push(
      ...fields[collection].map((field) => ({ [field]: { $nin: users } })),
    );
  if (collection === 'ChatMessages') {
    const groups = forms(
      rows
        .filter((row) => row.collection === 'Groups')
        .map((row) => row.contentId),
    );
    if (groups.length) filters.push({ groupId: { $nin: groups } });
  }
  const relation = {
    Comments: ['Posts', 'post', 'user'],
    Likes: ['Posts', 'post', 'user'],
    PostBookMark: ['Posts', 'postId', 'user'],
    EventMembers: ['Events', 'event', 'creator'],
  }[collection];
  if (relation) {
    const [parent, field, owner] = relation;
    const hiddenParents = forms(
      rows
        .filter((row) => row.collection === parent)
        .map((row) => row.contentId),
    );
    if (users.length)
      hiddenParents.push(
        ...(
          await db.db
            .collection(parent)
            .find({ [owner]: { $in: users } }, { projection: { _id: 1 } })
            .toArray()
        ).map((row) => row._id),
      );
    if (hiddenParents.length)
      filters.push({ [field]: { $nin: hiddenParents } });
  }
  return filters.length ? { $and: filters } : {};
}
