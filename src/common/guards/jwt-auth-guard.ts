import { Injectable } from '@nestjs/common';

import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  // Passport verifies the signature/expiry and JwtStrategy checks current
  // account state. Preserve its UnauthorizedException instead of returning 403.
}
