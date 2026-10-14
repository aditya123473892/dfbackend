import { SetMetadata } from '@nestjs/common';
import { ERole } from '../enums';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: ERole[]) => {
  return SetMetadata(ROLES_KEY, roles);
};
