import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'crypto';

/** Proves a phone was verified during signup, before the account exists. */
export type SignupClaims = { scope: 'phone_signup'; phone: string };
/** Password sign-in that may only add a phone (existing users on mobile). */
export type BootstrapClaims = { scope: 'phone_bootstrap'; sub: string };
type Claims = SignupClaims | BootstrapClaims;

export const SIGNUP_TOKEN_SECONDS = 30 * 60;
export const BOOTSTRAP_TOKEN_SECONDS = 15 * 60;

/**
 * Short-lived, single-purpose tokens. They are signed with a key derived from
 * JWT_SECRET, so JwtStrategy and the chat socket can never accept them as sessions.
 */
@Injectable()
export class ScopedTokens {
  private readonly secret: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.secret = createHmac('sha256', config.get<string>('JWT_SECRET') || '')
      .update('phone-otp-scoped-token:v1')
      .digest('hex');
  }

  sign(claims: Claims, expiresInSeconds: number): Promise<string> {
    return this.jwt.signAsync(claims, { secret: this.secret, expiresIn: expiresInSeconds });
  }

  async verify<S extends Claims['scope']>(
    token: string,
    scope: S,
  ): Promise<Extract<Claims, { scope: S }> | null> {
    try {
      const claims = await this.jwt.verifyAsync(token, { secret: this.secret, algorithms: ['HS256'] });
      return claims?.scope === scope ? claims : null;
    } catch {
      return null;
    }
  }
}
