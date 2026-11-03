import { Connection, Types } from 'mongoose';

/**
 * Resource authorization for media delivery; pair blocks/restrictions are checked by the caller.
 * `post` may be the row the caller just read; `once` lets one response share owner lookups.
 */
export async function canReadPost(db: Connection, postId: string, viewer: string, post?: any,
  once: <T>(key: string, run: () => Promise<T>) => Promise<T> = (_key, run) => run()) {
  if (!Types.ObjectId.isValid(postId) || !Types.ObjectId.isValid(viewer)) return false;
  post ??= await db.db.collection('Posts').findOne({ _id: new Types.ObjectId(postId) });
  if (!post) return false;
  const owner = String(post.user);
  if (owner === viewer) return true;
  if (post.status !== 'approved') return false;
  const follows = () => once(`follows:${viewer}:${owner}`, () => db.db.collection('follows').findOne({
    follower: new Types.ObjectId(viewer), following: new Types.ObjectId(owner), status: 'accepted',
  }));
  const account = await once(`private:${owner}`,
    () => db.db.collection('Users').findOne({ _id: new Types.ObjectId(owner) }, { projection: { isPrivate: 1 } }));
  if (account?.isPrivate === true && !await follows()) return false;
  if (post.visibility === 'public') return true;
  if (post.visibility === 'friends') return !!await follows();
  if (post.visibility !== 'private') return false;
  const now = new Date();
  return !!await db.db.collection('PostRequest').findOne({
    userId: new Types.ObjectId(owner), requestedUserId: new Types.ObjectId(viewer),
    status: 'accepted', startTime: { $lte: now }, endTime: { $gte: now },
  });
}
