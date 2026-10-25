import { Connection, Types } from 'mongoose';

/** Resource authorization for media delivery; pair blocks/restrictions are checked by the caller. */
export async function canReadPost(db: Connection, postId: string, viewer: string) {
  if (!Types.ObjectId.isValid(postId) || !Types.ObjectId.isValid(viewer)) return false;
  const post = await db.db.collection('Posts').findOne({ _id: new Types.ObjectId(postId) });
  if (!post) return false;
  const owner = String(post.user);
  if (owner === viewer) return true;
  if (post.status !== 'approved') return false;
  if (post.visibility === 'public') return true;
  if (post.visibility === 'friends') return !!await db.db.collection('follows').findOne({
    follower: new Types.ObjectId(viewer), following: new Types.ObjectId(owner), status: 'accepted',
  });
  if (post.visibility !== 'private') return false;
  const now = new Date();
  return !!await db.db.collection('PostRequest').findOne({
    userId: new Types.ObjectId(owner), requestedUserId: new Types.ObjectId(viewer),
    status: 'accepted', startTime: { $lte: now }, endTime: { $gte: now },
  });
}
