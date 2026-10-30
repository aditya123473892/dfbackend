import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, genSalt, hash } from 'bcrypt';
import { UsersService } from 'src/users/users.service';
import { TAuthMethod, TCreateToken } from 'src/common/types/auth';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async validateUser(username: string, password: string): Promise<any> {
    const user = await this.userService.findOneWithPassword(username);

    if (user && !user.isBlocked && !user.deletionRequestedAt && !(user.moderationSuspendedUntil > new Date()) &&
      (await this.comparePassword(password, user.password))) {
      user.password = '';
      return user;
    }
    throw new UnauthorizedException('Invalid username or password');
  }

  async hashPassword(password: string): Promise<string> {
    const salt = await genSalt(10);
    return hash(password, salt);
  }

  async comparePassword(
    providedPass: string,
    storedPass: string,
  ): Promise<boolean> {
    const passwordIsMatched = await compare(providedPass, storedPass);
    return passwordIsMatched;
  }

  async createTokens(
    user,
    authMethod: TAuthMethod = 'password',
  ): Promise<TCreateToken> {
    // let roles = user.roles.map((role) => role.name);

    const payload = {
      user: user.username,
      sub: user._id,
      roles: user.roles,
      // Preserve the method so sensitive routes can require a fresh OTP session.
      auth_method: authMethod,
    };
    const staff = user.roles?.some((role) => ['moderator', 'admin', 'root'].includes(role));
    const options = staff ? { expiresIn: Math.min(900, Math.max(60, Number(process.env.STAFF_TOKEN_TTL_SECONDS) || 900)) } : undefined;
    const accessToken = await this.jwtService.sign(payload, options);
    const cookieToken = await this.jwtService.sign(payload, options);
    return { accessToken, cookieToken };
  }

  async validateToken(token: string) {
    return await this.jwtService.verify(token);
  }
}
