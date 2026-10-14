import { ExecutionContext, Injectable } from '@nestjs/common';

import { AuthGuard } from '@nestjs/passport';

const jwt = require('jsonwebtoken');
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private superCanactivate;
  constructor() {
    super();
    this.superCanactivate = super.canActivate;
  }
  private configService = new ConfigService();

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const request = context.switchToHttp().getRequest();
      await this.superCanactivate(context);
      const authorizationToken = request.headers.authorization.split(' ')[1];

      //Check access token
      if (authorizationToken) {
        let result: any;
        try {
          const accessToken = jwt.verify(
            authorizationToken,
            this.configService.get<string>('JWT_SECRET'),
          );

          if (accessToken) return true;
          else false;
        } catch (error) {
          return false;
        }
      } else {
        return false;
      }
    } catch (error) {
      return false;
    }
  }
}
