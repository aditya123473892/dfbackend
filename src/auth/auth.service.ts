import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, genSalt, hash } from 'bcrypt';
import { UsersService } from 'src/users/users.service';
import { TCreateToken } from 'src/common/types/auth';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async validateUser(username: string, password: string): Promise<any> {
    const user = await this.userService.findOneWithPassword(username);

    if (user && (await this.comparePassword(password, user.password))) {
      user.password = '';
      return user;
    }
    throw new Error('Invalid password');;
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

  async createTokens(user): Promise<TCreateToken> {
    // let roles = user.roles.map((role) => role.name);

    console.log('user', user);

    const payload = {
      user: user.username,
      sub: user._id,
      roles: user.roles,
    };
    const accessToken = await this.jwtService.sign(payload);
    const cookieToken = await this.jwtService.sign(payload);
    return { accessToken, cookieToken };
  }

  async validateToken(token: string) {
    return await this.jwtService.verify(token);
  }
}
