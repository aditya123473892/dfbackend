import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ERole } from '../enums';
import { blockContext } from '../../user-blocks/block-context';

/** For existing owner-management routes only. JwtAuthGuard supplies current DB
 * roles; the controller/service still has to enforce resource ownership. */
@Injectable()
export class StaffToolVisibilityGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const { user } = context.switchToHttp().getRequest();
    if (!user) return false;
    if (
      [ERole.ADMIN, ERole.ROOT, ERole.MANAGER].some((role) =>
        user.roles?.includes(role),
      )
    ) {
      const visibility = blockContext.getStore();
      if (visibility) visibility.bypass = true;
    }
    return true;
  }
}
