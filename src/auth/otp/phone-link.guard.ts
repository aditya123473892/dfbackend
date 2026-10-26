import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { JwtAuthGuard } from 'src/common/guards';
import { ScopedTokens } from './scoped-token';

/**
 * Adding or changing a phone accepts either a normal session (web settings, mobile
 * settings) or the 15-minute bootstrap token an existing user gets on mobile from
 * a one-time password sign-in. Every other route rejects bootstrap tokens.
 */
@Injectable()
export class PhoneLinkGuard extends JwtAuthGuard {
  constructor(
    private readonly tokens: ScopedTokens,
    @InjectConnection() private readonly db: Connection,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header = String(req.headers?.authorization || '');
    const token = header.replace(/^Bearer\s+/i, '');
    const claims = token && token !== header ? await this.tokens.verify(token, 'phone_bootstrap') : null;
    if (!claims) return (await super.canActivate(context)) as boolean;

    if (!Types.ObjectId.isValid(claims.sub)) throw new UnauthorizedException();
    const user = await this.db.db.collection('Users').findOne({
      _id: new Types.ObjectId(claims.sub),
      isBlocked: { $ne: true },
      deletionRequestedAt: { $exists: false },
    });
    if (!user || user.moderationSuspendedUntil > new Date())
      throw new UnauthorizedException('Account is unavailable');
    req.user = { id: String(user._id), user: user.username, roles: user.roles, authMethod: 'phone_bootstrap' };
    return true;
  }
}
