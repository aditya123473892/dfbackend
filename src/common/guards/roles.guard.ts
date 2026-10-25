import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERole } from '../enums';
import { ROLES_KEY } from '../decorators';
import { blockContext } from '../../user-blocks/block-context';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<ERole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles) {
      return true;
    }
    const { user } = context.switchToHttp().getRequest();
    const allowed = requiredRoles.some(
      (role) =>
        user?.roles?.includes(role) || user?.roles?.includes(ERole.ROOT),
    );
    // Bypass only after an existing staff-only route has authorized the current
    // DB-backed identity. Being an admin on ordinary social routes grants none.
    if (
      allowed &&
      requiredRoles.some((role) =>
        [ERole.ADMIN, ERole.ROOT, ERole.MANAGER].includes(role),
      )
    ) {
      const visibility = blockContext.getStore();
      if (visibility) visibility.bypass = true;
    }
    return allowed;
  }
}
