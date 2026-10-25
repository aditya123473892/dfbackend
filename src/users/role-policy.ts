import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ClientSession, Connection, Types } from 'mongoose';
import { ERole } from '../common/enums';
import { preservationGate } from '../reports/preservation';

export async function protectLastRoot(db: Connection, targetId: string, session?: ClientSession) {
  if (!db?.getClient) return;
  const users = db.db.collection('Users');
  if ((await users.findOne({ _id: new Types.ObjectId(targetId) }, { session }))?.roles?.includes('root') &&
      await users.countDocuments({ roles: 'root', isBlocked: { $ne: true }, deletionRequestedAt: { $exists: false },
        $or: [{ moderationSuspendedUntil: null }, { moderationSuspendedUntil: { $lte: new Date() } }] }, { session }) <= 1)
    throw new ForbiddenException('The last root must be retained');
}

export function validateRoles(roles: unknown): asserts roles is ERole[] {
  if (!Array.isArray(roles) || !roles.length || new Set(roles).size !== roles.length ||
      roles.some((role) => !Object.values(ERole).includes(role)))
    throw new BadRequestException('Invalid roles');
}
export async function authorizeRoleGrant(db: Connection, actorId: string, proposed: unknown, previous: string[] = [], session?: ClientSession) {
  validateRoles(proposed);
  if (!actorId || !Types.ObjectId.isValid(actorId)) throw new ForbiddenException();
  const actor = await db.db.collection('Users').findOne({ _id: new Types.ObjectId(actorId), isBlocked: { $ne: true }, deletionRequestedAt: { $exists: false } }, { session });
  if (!actor || actor.moderationSuspendedUntil > new Date()) throw new ForbiddenException();
  if (actor.roles?.includes(ERole.ROOT)) return;
  if (!actor.roles?.includes(ERole.ADMIN) || [...previous, ...proposed].some((role) => ['admin', 'root'].includes(role)))
    throw new ForbiddenException('Only root can manage admin/root roles');
}
export async function changeRoles(db: Connection, actorId: string, targetId: string, roles: unknown) {
  validateRoles(roles);
  if (!Types.ObjectId.isValid(targetId)) throw new NotFoundException('User not found!');
  if (Types.ObjectId.isValid(actorId) && new Types.ObjectId(actorId).equals(new Types.ObjectId(targetId)))
    throw new ForbiddenException('You cannot change your own roles');
  return preservationGate(db, async () => {
    const session = await db.startSession();
    try {
      await session.withTransaction(async () => {
        const users = db.db.collection('Users');
        const target = await users.findOne({ _id: new Types.ObjectId(targetId) }, { session });
        if (!target) throw new NotFoundException('User not found!');
        await authorizeRoleGrant(db, actorId, roles, target.roles, session);
        if (target.roles?.includes('root') && !roles.includes(ERole.ROOT)) await protectLastRoot(db, targetId, session);
        await users.updateOne({ _id: target._id }, { $set: { roles } }, { session });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } finally { await session.endSession(); }
  });
}
