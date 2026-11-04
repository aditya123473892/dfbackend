import { performance } from 'perf_hooks';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { Types } from 'mongoose';
import { Harness } from './harness';
import { UsersService } from 'src/users/users.service';
import { FollowStatus } from 'src/common/schemas/follow.schema';
import { NotificationSchema } from 'src/common/schemas/notification.schema';
import { NotificationService } from 'src/notification/notification.service';
import { visiblePostQuery } from 'src/user-blocks/visible-post';
import { PushDelivery } from 'src/notification/push-delivery';
import { socialIndexes } from 'src/users/social-indexes';

describe('Social relationship persistence and following-first feed', () => {
  const h = new Harness();
  let users: UsersService;
  let notifications: NotificationService;
  beforeAll(async () => {
    await h.start();
    h.models.Notification = h.connection.model('Notification', NotificationSchema);
    await h.models.Notification.init();
    notifications = new NotificationService(h.models.Notification, h.blocks);
    users = new UsersService(h.models.Users, null, h.models.Follow, h.models.Posts, h.models.PostRequest,
      null, h.models.ChatMessage, h.blocks, notifications);
  });
  afterAll(() => h.stop());
  beforeEach(() => h.reset());
  const counts = async (id: string) => (await users.socialProfiles([await h.models.Users.findById(id)], id))[0];

  it('rolls back a new request when notification persistence fails and publishes only committed changes', async () => {
    const [a,b] = await h.users(2, { isPrivate: true });
    const events: unknown[] = [];
    const subscription = notifications.changes$.subscribe(event => events.push(event));
    const write = jest.spyOn(h.models.Notification, 'findOneAndUpdate');
    try {
      write.mockRejectedValueOnce(new Error('notification storage unavailable'));
      await expect(users.sendFollowRequest(a,b)).rejects.toThrow('notification storage unavailable');
      expect(await h.models.Follow.countDocuments()).toBe(0);
      expect(await h.models.Notification.countDocuments()).toBe(0);
      expect(events).toHaveLength(0);
      await users.sendFollowRequest(a,b);
      expect(await h.models.Follow.countDocuments()).toBe(1);
      expect(await h.models.Notification.countDocuments()).toBe(1);
      expect(events).toEqual([{ receiver:a, relationships:true },{ receiver:b, relationships:true }]);
    } finally { write.mockRestore(); subscription.unsubscribe(); }
  });

  it('rolls back acceptance and both counts on notification failure, then safely retries', async () => {
    const [a,b] = await h.users(2, { isPrivate: true });
    const edge: any = await users.sendFollowRequest(a,b);
    const write = jest.spyOn(h.models.Notification, 'findOneAndUpdate');
    try {
      write.mockRejectedValueOnce(new Error('notification storage unavailable'));
      await expect(users.approveFollowRequest(String(edge._id), FollowStatus.ACCEPTED,b)).rejects.toThrow();
      expect((await h.models.Follow.findById(edge._id)).status).toBe(FollowStatus.PENDING);
      expect(await users.followCounts(a)).toEqual({ followers:0, following:0 });
      expect(await users.followCounts(b)).toEqual({ followers:0, following:0 });
      expect(await h.models.Notification.countDocuments()).toBe(1);
      await users.approveFollowRequest(String(edge._id), FollowStatus.ACCEPTED,b);
      await users.approveFollowRequest(String(edge._id), FollowStatus.ACCEPTED,b);
      expect(await users.followCounts(a)).toEqual({ followers:0, following:1 });
      expect(await users.followCounts(b)).toEqual({ followers:1, following:0 });
      expect(await h.models.Notification.countDocuments()).toBe(2);
    } finally { write.mockRestore(); }
  });

  it('serializes acceptance against simultaneous cancellation without orphan counts or notifications', async () => {
    const [a,b] = await h.users(2, { isPrivate: true });
    const edge: any = await users.sendFollowRequest(a,b);
    await Promise.allSettled([
      users.approveFollowRequest(String(edge._id), FollowStatus.ACCEPTED,b),
      users.cancelFollowRequest(a,String(edge._id)),
    ]);
    const saved = await h.models.Follow.findById(edge._id);
    if (saved) expect(saved.status).toBe(FollowStatus.ACCEPTED);
    const accepted = saved ? 1 : 0;
    expect(await users.followCounts(a)).toEqual({ followers:0, following:accepted });
    expect(await users.followCounts(b)).toEqual({ followers:accepted, following:0 });
    expect(await h.models.Notification.countDocuments({ type:'follow_accepted' })).toBe(accepted);
  });

  it('creates one pending edge and notification under concurrent retries, then cancels and recreates', async () => {
    const [a, b, stranger] = await h.users(3, { isPrivate: true, followers: 999, following: 999 });
    const rows = await Promise.all(Array.from({ length: 20 }, () => users.sendFollowRequest(a,b)));
    expect(new Set(rows.map((r: any) => String(r._id))).size).toBe(1);
    expect(await h.models.Follow.countDocuments()).toBe(1);
    expect((await counts(a)).following).toBe(0);
    expect((await counts(b)).followers).toBe(0);
    expect(await h.models.Notification.countDocuments()).toBe(1);
    expect(await users.relationship(a,b)).toMatchObject({ status: 'requested' });
    await users.cancelFollowRequest(stranger, String((rows[0] as any)._id));
    expect(await h.models.Follow.countDocuments()).toBe(1);
    await users.cancelFollowRequest(a, String((rows[0] as any)._id));
    await users.cancelFollowRequest(a, String((rows[0] as any)._id));
    expect(await users.relationship(a,b)).toEqual({ status: 'none' });
    await users.sendFollowRequest(a,b);
    expect(await h.models.Notification.countDocuments()).toBe(2);
  });

  it('authorizes accept/reject, derives accurate counts on every mutation and permits retry after rejection', async () => {
    const [a,b,c] = await h.users(3, { isPrivate: true });
    const edge: any = await users.sendFollowRequest(a,b);
    await expect(users.approveFollowRequest(String(edge._id), FollowStatus.ACCEPTED,c)).rejects.toThrow();
    await Promise.all(Array.from({ length: 10 }, () => users.approveFollowRequest(String(edge._id),FollowStatus.ACCEPTED,b)));
    expect((await counts(a)).following).toBe(1);
    expect((await counts(b)).followers).toBe(1);
    expect(await users.followCounts(b)).toEqual({ followers: 1, following: 0 });
    expect(await users.relationship(a,b)).toMatchObject({ status: 'following' });
    expect(await users.getFollowers(b)).toHaveLength(1);
    expect(await users.getFollowing(a)).toHaveLength(1);
    await users.unfollowUser(a,b); await users.unfollowUser(a,b);
    expect((await counts(a)).following).toBe(0);
    expect((await counts(b)).followers).toBe(0);
    expect(await users.followCounts(b)).toEqual({ followers: 0, following: 0 });
    const rejected: any = await users.sendFollowRequest(a,b);
    await users.approveFollowRequest(String(rejected._id),FollowStatus.REJECTED,b);
    await users.approveFollowRequest(String(rejected._id),FollowStatus.REJECTED,b);
    expect(await users.relationship(a,b)).toEqual({ status: 'none' });
    await users.sendFollowRequest(a,b);
    expect(await users.getFollowRequests(b)).toHaveLength(1);
    expect((await counts(a)).following).toBe(0);
    await expect(users.sendFollowRequest(a,a)).rejects.toThrow();
  });

  it('follows explicitly public accounts immediately and initializes Discover from persisted state', async () => {
    const [a,b,c] = await h.users(3, { isPrivate: false });
    await users.sendFollowRequest(a,b);
    await h.models.Users.updateOne({ _id: c }, { $set: { isPrivate: true } });
    await users.sendFollowRequest(a,c);
    const find = jest.spyOn(h.models.Posts, 'find');
    const page = await users.findAll({ limit: 20, summary: 'true' } as any,a);
    expect(page.users.find(u => String(u._id) === b).relationship.status).toBe('following');
    expect(page.users.find(u => String(u._id) === c).relationship.status).toBe('requested');
    expect(find).not.toHaveBeenCalled(); find.mockRestore();
    expect((await users.findById(b)).followers).toBe(1);
  });

  it('orders entire followed group first across pages, with stable equal-time ties and a refresh snapshot', async () => {
    const [viewer, followed, other] = await h.users(3, { isPrivate: false });
    await users.sendFollowRequest(viewer,followed);
    const date = new Date('2026-01-01');
    const f = await Promise.all([1,2,3].map(i => h.post(followed,{ caption: 'followed'+i, createdAt: date })));
    const g = await Promise.all([1,2,3].map(i => h.post(other,{ caption: 'generic'+i, createdAt: new Date('2026-02-01') })));
    const params: any = { visibility:'public', status:'approved', limit:2, cursor:'start' };
    const first = await h.posts.findAllPublic(params,viewer);
    await h.post(other, { caption: 'arrived-after-snapshot', createdAt: new Date(Date.now()+1000) });
    const second = await h.posts.findAllPublic({ ...params,cursor:first.nextCursor },viewer);
    const third = await h.posts.findAllPublic({ ...params,cursor:second.nextCursor },viewer);
    const actual = [...first.posts,...second.posts,...third.posts].map(p => String(p._id));
    expect(actual).toEqual([...f,...g].reduce((groups: any, p: any) => {
      (String(p.user) === followed ? groups[0] : groups[1]).push(String(p._id)); return groups;
    }, [[],[]]).flatMap((ids: string[]) => ids.sort().reverse()));
    expect(new Set(actual).size).toBe(6);
    expect(third.nextCursor).toBeUndefined();
    await users.unfollowUser(viewer,followed);
    await expect(h.posts.findAllPublic({ ...params,cursor:first.nextCursor },viewer)).rejects.toThrow('Refresh');
  });

  it('excludes blocked authors, private accounts without accepted follows, and non-public/pending posts', async () => {
    const [viewer, blocked, privateUser, visible] = await h.users(4, { isPrivate: false });
    await h.models.Users.updateOne({ _id: privateUser }, { $set:{isPrivate:true} });
    await h.connection.db.collection('UserBlocks').insertOne({ blockerId:new Types.ObjectId(blocked),blockedId:new Types.ObjectId(viewer) });
    await h.post(blocked); await h.post(privateUser); await h.post(visible,{visibility:'private'}); await h.post(visible,{status:'pending'});
    const allowed = await h.post(visible);
    const page = await h.posts.findAllPublic({ visibility:'public',status:'approved',cursor:'start' } as any,viewer);
    expect(page.posts.map(p=>String(p._id))).toEqual([String(allowed._id)]);
    await expect(h.posts.findVisiblePost(String((await h.post(privateUser))._id),viewer)).rejects.toThrow();
  });

  it('persists direct-message notifications independently from push and deduplicates a retried text send', async () => {
    const [a,b] = await h.users(2);
    (h.chat as any).notifications = notifications;
    const input = { sender:a,receiver:b,message:'Do not put this text in a push',clientId:'unique-message-123' };
    await h.chat.saveTextMessage(input); await h.chat.saveTextMessage(input);
    const page = await notifications.list(b);
    expect(page.notifications).toHaveLength(1);
    expect(page.unreadCount).toBe(1);
    expect(page.notifications[0]).toMatchObject({ type:'direct_message',message:'New direct message',navigation:{conversationId:'user:'+a} });
    const row = await h.models.Notification.findOne();
    expect(row.pushQueued).toBe(false);
    expect(JSON.stringify(row)).not.toContain(input.message);
    await notifications.markRead(b);
    expect((await notifications.list(b)).unreadCount).toBe(0);
  });

  it('measures the original Discover query path against summary reads on the same local dataset', async () => {
    const ids = await h.users(20, { isPrivate:false });
    for (const id of ids) for(let i=0;i<3;i++) await h.post(id);
    let operations=0;
    h.connection.set('debug', () => { operations++; });
    const legacy = async () => {
      const rows = await h.models.Users.find().limit(20);
      await h.models.Users.countDocuments();
      return Promise.all(rows.map(async u => ({ ...u.toObject(), usersPost: await visiblePostQuery(h.models.Posts.find({
        user:u._id,visibility:'public',status:'approved',
      })).exec() })));
    };
    const summary = async () => (await users.findAll({limit:20,summary:'true'} as any,ids[0])).users;
    await legacy(); await summary();
    const measure = async (fn: () => Promise<any>) => {
      const times:number[]=[]; operations=0; let bytes=0;
      for(let i=0;i<10;i++){ const start=performance.now(); const data=await fn(); times.push(performance.now()-start); bytes=Buffer.byteLength(JSON.stringify(data)); }
      return { samples:times.length, meanMs:times.reduce((a,b)=>a+b,0)/times.length, queriesPerRead:operations/times.length, payloadBytes:bytes };
    };
    const before=await measure(legacy), after=await measure(summary);
    h.connection.set('debug',false);
    const report={ environment:'Local MongoMemoryReplSet; 20 users, 60 posts, warmed service calls; no HTTP/media URL signing/device rendering',before,after };
    writeFileSync(resolve(__dirname,'../../../artifacts/social-performance.json'),JSON.stringify(report,null,2));
    expect(after.queriesPerRead).toBeLessThan(before.queriesPerRead);
    expect(after.payloadBytes).toBeLessThan(before.payloadBytes);
  });

  it('keeps recent notifications pending until a device registers without starving other recipients', async () => {
    const [sender, waiting, reachable] = await h.users(3);
    const push = new PushDelivery(h.connection, h.blocks);
    await push.onModuleInit();
    await h.connection.db.collection('PushTokens').deleteMany({});
    await h.connection.db.collection('PushDeliveries').deleteMany({});
    const first = await notifications.sendNotification(waiting, sender, 'direct_message' as any, 'New message');
    await push.flush();
    expect(await h.models.Notification.findById(first._id).lean()).toMatchObject({ pushQueued: false });
    // More than a worker page of accounts without tokens must not block a registered phone.
    for (let i = 0; i < 55; i++) await notifications.sendNotification(waiting, sender, 'direct_message' as any, 'New message');
    await push.register(reachable, 'ExponentPushToken[reachable-device-token-12345]');
    await notifications.sendNotification(reachable, sender, 'direct_message' as any, 'New message');
    const original = global.fetch;
    const transport = jest.fn(async () => ({ ok: true, json: async () => ({ data: [{ status: 'ok', id: 'ticket' }] }) }));
    try {
      global.fetch = transport as any;
      await push.flush();
      expect(transport).toHaveBeenCalledTimes(1);
      expect(await h.connection.db.collection('PushDeliveries').findOne({ owner: reachable })).toMatchObject({ state: 'receipt' });
      await push.register(waiting, 'ExponentPushToken[late-device-token-12345]');
      await push.flush();
      expect(await h.models.Notification.findById(first._id).lean()).toMatchObject({ pushQueued: true });
      expect(await h.connection.db.collection('PushDeliveries').findOne({ notificationId: String(first._id) })).toMatchObject({ owner: waiting });
      await push.flush();
      expect(await h.connection.db.collection('PushDeliveries').countDocuments({ notificationId: String(first._id) })).toBe(1);
    } finally {
      global.fetch = original;
      await h.connection.db.collection('PushTokens').deleteMany({});
      await h.connection.db.collection('PushDeliveries').deleteMany({});
    }
  });

  it('push retries preserve notifications, enforce token ownership, deduplicate jobs and remove invalid devices', async () => {
    const [a,b] = await h.users(2);
    const push = new PushDelivery(h.connection,h.blocks);
    await push.onModuleInit();
    const token='ExponentPushToken[valid-device-token-12345]';
    await push.register(b,token); await push.register(a,token,true);
    expect(await h.connection.db.collection('PushTokens').countDocuments()).toBe(1);
    await notifications.sendNotification(b,a,'direct_message' as any,'New direct message',{},'push-test');
    const original=global.fetch;
    try {
      const transport=jest.fn().mockRejectedValue(new Error('offline'));
      global.fetch=transport;
      await push.flush();
      expect((await notifications.list(b)).unreadCount).toBe(1);
      const jobs=h.connection.db.collection<any>('PushDeliveries');
      expect(await jobs.countDocuments()).toBe(1);
      expect(await jobs.findOne()).toMatchObject({state:'pending',attempts:1});
      await jobs.updateMany({},{$set:{nextAttempt:new Date(0)}});
      transport.mockResolvedValueOnce({ok:true,json:async()=>({data:[{status:'ok',id:'ticket'}]})});
      await push.flush();
      expect(await jobs.findOne()).toMatchObject({state:'receipt',ticket:'ticket'});
      await jobs.updateMany({},{$set:{nextAttempt:new Date(0)}});
      transport.mockResolvedValueOnce({ok:true,json:async()=>({data:{ticket:{status:'error',details:{error:'DeviceNotRegistered'}}}})});
      await push.flush();
      expect(await jobs.findOne()).toMatchObject({state:'invalid'});
      expect(await h.connection.db.collection('PushTokens').countDocuments()).toBe(0);
      expect((await notifications.list(b)).notifications).toHaveLength(1);
      expect(transport.mock.calls[1][1].body).not.toContain('password');
    } finally {global.fetch=original;await h.connection.db.collection('PushDeliveries').deleteMany({});}
  });

  it('bounds feed comment previews while retaining full counts and the viewer like state', async () => {
    const [author,viewer,other]=await h.users(3,{isPrivate:false});
    const post=await h.post(author);
    for(let i=0;i<10;i++) await h.posts.createComment({post:String(post._id),user:author,content:'Comment '+i});
    await h.posts.likePost(String(post._id),viewer); await h.posts.likePost(String(post._id),other);
    const page=await h.posts.findAllPublic({visibility:'public',status:'approved',cursor:'start',summary:'true'} as any,viewer);
    expect(page.posts[0]).toMatchObject({commentCount:10,likeCount:2,likedByMe:true});
    expect(page.posts[0].comments.length).toBeLessThanOrEqual(3);
    const legacy=await h.posts.findAllPublic({visibility:'public',status:'approved',cursor:'start'} as any,viewer);
    expect(legacy.posts[0].comments).toHaveLength(10);
  });

  it('archives legacy duplicate edges transactionally before adding the unique index', async () => {
    const edges=h.models.Follow.collection;
    await edges.dropIndex('follower_1_following_1');
    const [a,b]=await h.users(2);
    const pair={follower:new Types.ObjectId(a),following:new Types.ObjectId(b)};
    await edges.insertMany([{...pair,status:'pending'},{...pair,status:'accepted'},{...pair,status:'rejected'}]);
    await socialIndexes(h.connection);
    expect(await edges.countDocuments()).toBe(1);
    expect(await edges.findOne()).toMatchObject({status:'accepted'});
    expect(await h.connection.db.collection('FollowDuplicateArchive').countDocuments()).toBe(2);
    await socialIndexes(h.connection);
    expect((await counts(b)).followers).toBe(1);
  });

  it('keeps imported posts without timestamps visible and paginates them without duplicates', async () => {
    const [author,viewer]=await h.users(2,{isPrivate:false});
    const ids=[new Types.ObjectId(),new Types.ObjectId(),new Types.ObjectId()];
    await h.models.Posts.collection.insertMany(ids.map(_id=>({_id,user:new Types.ObjectId(author),visibility:'public',status:'approved',likes:[],comments:[],media:[]})));
    const params:any={visibility:'public',status:'approved',cursor:'start',limit:2};
    const first=await h.posts.findAllPublic(params,viewer);
    const second=await h.posts.findAllPublic({...params,cursor:first.nextCursor},viewer);
    expect([...first.posts,...second.posts].map(p=>String(p._id))).toEqual(ids.map(String).reverse());
    await socialIndexes(h.connection);
    expect(await h.models.Posts.collection.countDocuments({createdAt:{$type:'date'}})).toBe(3);
  });
});
