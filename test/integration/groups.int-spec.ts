import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { Harness, clientId } from './harness';

describe('Groups (MongoDB integration)', () => {
  const h = new Harness();
  beforeAll(() => h.start());
  afterAll(() => h.stop());
  beforeEach(() => h.reset());

  it('creates a group with the creator as owner and deduplicated members', async () => {
    const [owner, a, b] = await h.users(3);
    const group = await h.groups.createGroup(
      { name: '  Book club  ', description: ' Monthly ', members: [a, b, a, owner], admin: a },
      owner,
    );
    expect(group).toMatchObject({ name: 'Book club', description: 'Monthly' });
    expect(String(group.admin)).toBe(owner); // a client-sent admin is ignored
    expect(group.members.map(String).sort()).toEqual([owner, a, b].sort());
    expect(group).not.toHaveProperty('clientId');
    expect(h.gateway.syncGroupMembership).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([owner, a, b]));
  });

  it('rejects invalid group input', async () => {
    const [owner, a] = await h.users(2);
    await expect(h.groups.createGroup({ name: '   ', members: [a] }, owner)).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.groups.createGroup({ name: 'x'.repeat(101), members: [a] }, owner)).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.groups.createGroup({ name: 'Solo', members: [owner] }, owner)).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      h.groups.createGroup({ name: 'Ghosts', members: [new Types.ObjectId().toHexString()] }, owner),
    ).rejects.toBeInstanceOf(BadRequestException);
    const [blocked] = await h.users(1, { isBlocked: true });
    await expect(h.groups.createGroup({ name: 'Blocked', members: [blocked] }, owner)).rejects.toBeInstanceOf(BadRequestException);
    expect(await h.models.Group.countDocuments()).toBe(0);
  });

  it('creates one group for duplicate concurrent submissions with the same clientId', async () => {
    const [owner, a] = await h.users(2);
    const key = clientId();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => h.groups.createGroup({ name: 'Once', members: [a], clientId: key }, owner)),
    );
    expect(new Set(results.map((group) => String(group._id))).size).toBe(1);
    expect(await h.models.Group.countDocuments()).toBe(1);
  });

  it('enforces the member limit on create and on add', async () => {
    // The limit is read when the module loads, so load a copy with a small one.
    process.env.GROUP_MAX_MEMBERS = '3';
    let LimitedGroupService: any;
    jest.isolateModules(() => {
      LimitedGroupService = require('src/group-chat/group.service').GroupService;
    });
    delete process.env.GROUP_MAX_MEMBERS;
    const limited = new LimitedGroupService(h.models.Group, h.models.Users, h.chat, h.gateway, h.blocks, h.photos);
    const [owner, a, b, c] = await h.users(4);

    await expect(limited.createGroup({ name: 'Too big', members: [a, b, c] }, owner)).rejects.toThrow(
      'limited to 3 members',
    );
    const group = await limited.createGroup({ name: 'Just right', members: [a, b] }, owner);
    await expect(limited.addMembers({ groupId: String(group._id), members: [c] }, owner)).rejects.toThrow(
      'limited to 3 members',
    );
    expect((await h.models.Group.findById(group._id)).members).toHaveLength(3);
  });

  it('lets only the owner add or remove members, and keeps the owner', async () => {
    const [owner, member, outsider, extra] = await h.users(4);
    const group = await h.groups.createGroup({ name: 'Crew', members: [member] }, owner);
    const groupId = String(group._id);

    await expect(h.groups.addMembers({ groupId, members: [outsider] }, member)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.groups.addMembers({ groupId, members: [outsider] }, outsider)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.groups.removeMembers({ groupId, members: [owner] }, owner)).rejects.toBeInstanceOf(ForbiddenException);

    const added = await h.groups.addMembers({ groupId, members: [extra, extra] }, owner);
    expect(added.members.map(String).sort()).toEqual([owner, member, extra].sort());
    expect(h.gateway.syncGroupMembership).toHaveBeenLastCalledWith(expect.anything(), [extra]);

    const removed = await h.groups.removeMembers({ groupId, members: [member] }, owner);
    expect(removed.members.map(String).sort()).toEqual([owner, extra].sort());
    expect(h.gateway.syncGroupMembership).toHaveBeenLastCalledWith(expect.anything(), [], [member]);

    // A removed member immediately loses access.
    await expect(h.chat.assertGroupMember(member, groupId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.groups.getGroupMembers(groupId, member)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('handles concurrent adds without losing members', async () => {
    const [owner, first, ...others] = await h.users(8);
    const group = await h.groups.createGroup({ name: 'Busy', members: [first] }, owner);
    await Promise.all(others.map((id) => h.groups.addMembers({ groupId: String(group._id), members: [id] }, owner)));
    const stored = await h.models.Group.findById(group._id);
    expect(stored.members).toHaveLength(8);
  });

  it('lets members send group messages and hides member contact details', async () => {
    const [owner, member] = await h.users(2);
    const group = await h.groups.createGroup({ name: 'Talk', members: [member] }, owner);
    const groupId = String(group._id);
    await h.chat.saveTextMessage({ sender: member, groupId, message: 'hello all', type: 'group' });
    const history = await h.chat.getChatGroupHistory(owner, groupId, { limit: 20 });
    expect(history.map((m: any) => m.message)).toEqual(['hello all']);

    const detail = await h.groups.getGroupMembers(groupId, member);
    for (const user of detail.members as any[]) {
      expect(user).not.toHaveProperty('phoneNumber');
      expect(user).not.toHaveProperty('username');
    }
  });

  it('transfers ownership when the owner leaves and deletes the group with its last member', async () => {
    const [owner, member] = await h.users(2);
    const group = await h.groups.createGroup({ name: 'Relay', members: [member] }, owner);
    const groupId = String(group._id);
    await h.chat.saveTextMessage({ sender: owner, groupId, message: 'bye', type: 'group' });

    const left = await h.groups.leaveGroup(groupId, owner);
    expect(left).toMatchObject({ left: true, deleted: false, admin: member });
    await expect(h.chat.assertGroupMember(owner, groupId)).rejects.toBeInstanceOf(ForbiddenException);

    const last = await h.groups.leaveGroup(groupId, member);
    expect(last).toMatchObject({ deleted: true });
    expect(await h.models.Group.countDocuments()).toBe(0);
    expect(await h.models.ChatMessage.countDocuments({ groupId })).toBe(0);
    expect(h.gateway.broadcastGroupDeleted).toHaveBeenCalledWith(groupId);
  });

  it('lets only the owner delete a group, removing messages and read cursors', async () => {
    const [owner, member] = await h.users(2);
    const group = await h.groups.createGroup({ name: 'Temporary', members: [member] }, owner);
    const groupId = String(group._id);
    await h.chat.saveTextMessage({ sender: member, groupId, message: 'hi', type: 'group' });

    await expect(h.groups.deleteGroup(groupId, member)).rejects.toBeInstanceOf(ForbiddenException);
    await h.groups.deleteGroup(groupId, owner);
    expect(await h.models.Group.countDocuments()).toBe(0);
    expect(await h.models.ChatMessage.countDocuments()).toBe(0);
    expect(await h.models.ChatReadCursor.countDocuments()).toBe(0);
  });

  it('lets only the owner rename a group and validates the update', async () => {
    const [owner, member] = await h.users(2);
    const group = await h.groups.createGroup({ name: 'Old', members: [member] }, owner);
    const groupId = String(group._id);
    await expect(h.groups.updateGroup(groupId, { name: 'Hijacked' }, member)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.groups.updateGroup(groupId, { name: '  ' }, owner)).rejects.toBeInstanceOf(BadRequestException);
    expect(await h.groups.updateGroup(groupId, { name: 'New', description: '' }, owner)).toMatchObject({ name: 'New', description: '' });
  });

  // PhotoResponseInterceptor signs `groupIcon` on the way out.
  it('returns the stored group image reference for signing, never the legacy key field', async () => {
    const [owner, member] = await h.users(2);
    const group = await h.groups.createGroup({ name: 'Pictured', members: [member] }, owner);
    await h.models.Group.updateOne({ _id: group._id }, { groupIconKey: 'groupIcon/abc.png' });
    const detail = await h.groups.getGroupMembers(String(group._id), owner);
    expect(detail.groupIcon).toBe('groupIcon/abc.png');
    expect(detail).not.toHaveProperty('groupIconKey');
    const [conversation] = await h.chat.getConversations(member);
    expect((conversation as any).group.groupIcon).toBe('groupIcon/abc.png');
  });
});
