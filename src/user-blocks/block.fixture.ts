import { Subject } from 'rxjs';
/** Explicit allow policy for pre-existing authorization unit fixtures. */
export function unblockedPolicy(): any {
  return {
    assertVisible: jest.fn().mockResolvedValue(undefined),
    isBlockedEitherWay: jest.fn().mockResolvedValue(false),
    ids: jest.fn().mockResolvedValue([]),
    changes$: new Subject(),
    groupRemoval$: new Subject(),
    groupMembers: jest.fn().mockResolvedValue([]),
  };
}

/**
 * GroupService for persistence-level tests: real group model and block
 * policy, no-op read cursors and live socket sync.
 */
export function groupServiceFor(groups: any, blocks: any, users?: any) {
  // Required lazily so unit fixtures do not load the group module graph.
  const { GroupService } = require('../group-chat/group.service');
  const chat = {
    initializeGroupReadCursors: async () => undefined,
    removeGroupReadCursors: async () => undefined,
    deleteGroupConversation: async () => undefined,
  };
  const gateway = {
    syncGroupMembership: () => undefined,
    broadcastGroupDeleted: () => undefined,
  };
  return new GroupService(groups, users, chat, gateway, blocks, undefined);
}
