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
