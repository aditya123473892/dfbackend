import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { IAuthUser } from 'src/common/interfaces';

export const AuthUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): IAuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
