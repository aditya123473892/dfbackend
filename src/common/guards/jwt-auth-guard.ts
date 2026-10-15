import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Bearer JWT guard. The passport strategy verifies signature and expiry and
 * sets request.user. A missing, invalid or expired token is a 401 so clients
 * can tell an ended session apart from a permission failure (403).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return (await super.canActivate(context)) as boolean;
    } catch (_error) {
      throw new UnauthorizedException('Authentication required');
    }
  }
}
