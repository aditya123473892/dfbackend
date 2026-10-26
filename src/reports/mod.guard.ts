import { CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { blockContext } from '../user-blocks/block-context';

export function modEnabled() { return process.env.MOD_API_ENABLED === 'on'; }
export function verifyModConfiguration() {
  if (!['off', 'on'].includes(process.env.MOD_API_ENABLED || 'off')) throw new Error('MOD_API_ENABLED must be off or on');
  if (modEnabled() && process.env.NODE_ENV === 'production' &&
    (process.env.STAFF_MFA_ENABLED !== 'on' || !process.env.STAFF_MFA_ISSUER ||
      !/^\d+$/.test(process.env.STAFF_TOKEN_TTL_SECONDS || '') ||
      Number(process.env.STAFF_TOKEN_TTL_SECONDS) < 60 || Number(process.env.STAFF_TOKEN_TTL_SECONDS) > 900 ||
      !process.env.STAFF_AUDIT_DATABASE_URL))
    throw new Error('Production moderation requires staff MFA issuer/enforcement, 60-900 second staff tokens and an insert-only staff audit database credential');
}
@Injectable()
export class ModFeatureGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (!modEnabled()) {
      const req = context.switchToHttp().getRequest();
      throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
    }
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store');
    return true;
  }
}
@Injectable()
export class ModCaseGuard implements CanActivate {
  constructor(@InjectConnection() private readonly db: Connection) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const user = await this.db.db.collection('Users').findOne({ _id: new Types.ObjectId(req.user.id),
      isBlocked: { $ne: true }, deletionRequestedAt: { $exists: false } });
    if (!user || user.moderationSuspendedUntil > new Date() || !user.roles?.some((role) => ['moderator', 'admin', 'root'].includes(role)))
      throw new ForbiddenException();
    if (process.env.NODE_ENV === 'production') {
      const claims = req.user.staffClaims;
      const maximum = Number(process.env.STAFF_TOKEN_TTL_SECONDS);
      if (!claims || claims.iss !== process.env.STAFF_MFA_ISSUER || !Array.isArray(claims.amr) || !claims.amr.includes('mfa') ||
          !Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || claims.exp <= claims.iat ||
          claims.iat > Date.now() / 1000 + 30 || claims.exp - claims.iat > maximum || Date.now() / 1000 - claims.iat > maximum)
        throw new ForbiddenException('A recent staff MFA session is required');
    }
    req.user.roles = user.roles;
    const visibility = blockContext.getStore();
    if (visibility) visibility.bypass = true;
    return true;
  }
}
