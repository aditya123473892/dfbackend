import { AsyncLocalStorage } from 'async_hooks';
import { Connection, Schema, Types } from 'mongoose';
import { restrictionFilter } from '../reports/restricted-content';

type VisibilityContext = {
  viewerId?: string;
  bypass?: boolean;
  ids?: Promise<string[]>;
  restrictions?: Promise<any[]>;
  authSelf?: boolean;
};
export const blockContext = new AsyncLocalStorage<VisibilityContext>();
/** Legacy chat fields are Mixed and contain both BSON ObjectIds and strings. */
export const bsonIds = (ids: string[]) =>
  ids.flatMap((id) => [id, new Types.ObjectId(id)]);
export const referenceId = (id: string) => ({ $in: bsonIds([id]) });

export async function pairBlocked(
  db: Connection,
  a: string,
  b: string,
): Promise<boolean> {
  if (a === b) return false;
  if (!Types.ObjectId.isValid(a) || !Types.ObjectId.isValid(b)) return true;
  const left = new Types.ObjectId(a),
    right = new Types.ObjectId(b);
  return !!(await db.db.collection('UserBlocks').findOne(
    {
      $or: [
        { blockerId: left, blockedId: right },
        { blockerId: right, blockedId: left },
      ],
    },
    { projection: { _id: 1 } },
  ));
}

/** One memo per HTTP request, never shared between accounts or requests. */
export async function blockedIds(
  db: Connection,
  viewerId: string,
  fresh = false,
): Promise<string[]> {
  const context = blockContext.getStore();
  const read = async () => {
    const id = new Types.ObjectId(viewerId);
    const rows = await db.db
      .collection('UserBlocks')
      .find(
        {
          $or: [{ blockerId: id }, { blockedId: id }],
        },
        { projection: { blockerId: 1, blockedId: 1 } },
      )
      .toArray();
    return [
      ...new Set(
        rows.map((row) =>
          String(
            String(row.blockerId) === viewerId ? row.blockedId : row.blockerId,
          ),
        ),
      ),
    ];
  };
  if (fresh || !context || context.viewerId !== viewerId) return read();
  return (context.ids ??= read());
}

export function visibilityFilter(
  collection: string,
  ids: string[],
): Record<string, any> {
  if (!ids.length) return {};
  const excluded = bsonIds(ids);
  const fields: Record<string, string[]> = {
    Users: ['_id'],
    Posts: ['user'],
    Comments: ['user'],
    Likes: ['user'],
    Events: ['creator'],
    EventMembers: ['user'],
    follows: ['follower', 'following'],
    PostRequest: ['userId', 'requestedUserId'],
    UserBookMark: ['bookMarkUser'],
    Notifications: ['sender', 'receiver'],
    UserEdits: ['user'],
  };
  if (collection === 'ChatMessages')
    return {
      $or: [
        { groupId: { $ne: null } },
        { sender: { $nin: excluded }, receiver: { $nin: excluded } },
      ],
    };
  return fields[collection]
    ? {
        $and: fields[collection].map((field) => ({
          [field]: { $nin: excluded },
        })),
      }
    : {};
}

export async function visibilityPredicate(
  db: Connection,
  collection: string,
  viewer: string,
) {
  const ids = await blockedIds(db, viewer);
  const base = visibilityFilter(collection, ids);
  if (!ids.length) return base;
  const excluded = bsonIds(ids);
  const relation = {
    Comments: ['Posts', 'user', 'post'],
    Likes: ['Posts', 'user', 'post'],
    PostBookMark: ['Posts', 'user', 'postId'],
    EventMembers: ['Events', 'creator', 'event'],
  }[collection];
  if (!relation) return base;
  const [source, owner, field] = relation;
  const hidden = await db.db
    .collection(source)
    .find({ [owner]: { $in: excluded } }, { projection: { _id: 1 } })
    .toArray();
  return { $and: [base, { [field]: { $nin: hidden.map((row) => row._id) } }] };
}

/** Covers population queries, counts and pagination before execution. Raw storage/auth
 * collections deliberately remain outside this plugin; their entry points authorize explicitly. */
export function blockQueryPlugin(schema: Schema) {
  schema.pre(
    ['find', 'findOne', 'countDocuments', 'distinct'],
    async function () {
      const context = blockContext.getStore();
      const pair = context?.viewerId && !context.bypass ? await visibilityPredicate(
        this.model.db,
        this.model.collection.name,
        context.viewerId,
      ) : {};
      const rows = context && this.model.db?.getClient ? await (context.restrictions ??= this.model.db.db.collection('RestrictedContent').find({}).toArray()) : undefined;
      // Hiding a profile must not disable its verified owner's /auth/me or vault.
      const ownAuth = context?.authSelf && this.model.collection.name === 'Users' && String(this.getFilter()._id) === context.viewerId;
      const restricted = ownAuth ? {} : await restrictionFilter(this.model.db, this.model.collection.name, rows);
      const filter = Object.keys(restricted).length ? { $and: [pair, restricted] } : pair;
      if (Object.keys(filter).length)
        this.setQuery({ $and: [this.getFilter(), filter] });
    },
  );
  schema.pre('aggregate', async function () {
    const context = blockContext.getStore();
    const pair = context?.viewerId && !context.bypass ? await visibilityPredicate(
      this.model().db,
      this.model().collection.name,
      context.viewerId,
    ) : {};
    const restricted = await restrictionFilter(this.model().db, this.model().collection.name);
    const filter = Object.keys(restricted).length ? { $and: [pair, restricted] } : pair;
    if (Object.keys(filter).length)
      this.pipeline().splice((this.pipeline()[0] as any)?.$geoNear ? 1 : 0, 0, {
        $match: filter,
      });
  });
}
