import { HttpException, HttpStatus, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { EBlockedByEnum, ERole } from 'src/common/enums';
import { MailService } from 'src/mail/mail.service';
import { UsersService } from 'src/users/users.service';
import { AuthService } from '../auth.service';
import { OtpSignupDto } from './otp.dto';
import { otpError } from './otp-errors';
import { maskPhone, normalizePhone, throttleKey } from './phone';
import { ONE_DAY, OtpThrottle, TEN_MINUTES } from './otp-throttle';
import { BOOTSTRAP_TOKEN_SECONDS, ScopedTokens, SIGNUP_TOKEN_SECONDS } from './scoped-token';
import { TwilioVerifyClient } from './twilio-verify.client';

// Same wording as POST /auth/login so existing clients map them identically.
const UNVERIFIED_EMAIL = "Your account isn't verified yet, Please check your email.";

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly mail: MailService,
    private readonly twilio: TwilioVerifyClient,
    private readonly throttle: OtpThrottle,
    private readonly tokens: ScopedTokens,
  ) {}

  /**
   * Login sends only reach numbers linked to an account, but the response is the same
   * either way. Signup sends go to any valid number; ownership is checked at verify.
   */
  async sendCode(input: string, purpose: 'login' | 'signup', ip: string) {
    const phone = this.phone(input);
    if (purpose === 'signup') await this.deliver(phone, ip, { send: true, quiet: false });
    else
      await this.deliver(phone, ip, {
        send: Boolean(await this.users.findByVerifiedPhone(phone)),
        quiet: true,
      });
    return { resendAfterSeconds: this.throttle.limits.resendCooldownSeconds };
  }

  async verifyLogin(input: string, code: string, ip: string) {
    const phone = this.phone(input);
    await this.limitChecks(phone, ip);
    const user = await this.users.findByVerifiedPhone(phone);
    // Nothing was sent to an unknown number: answer exactly as Twilio would.
    if (!user) throw otpError('OTP_EXPIRED');
    await this.approve(phone, code);
    return this.signIn(user);
  }

  async verifySignup(input: string, code: string, ip: string) {
    const phone = this.phone(input);
    await this.limitChecks(phone, ip);
    await this.approve(phone, code);
    // Revealed only to someone who just proved they hold the number.
    if (await this.users.phoneOwnerId(phone)) throw otpError('PHONE_IN_USE');
    const signupToken = await this.tokens.sign({ scope: 'phone_signup', phone }, SIGNUP_TOKEN_SECONDS);
    return { signupToken, phone, expiresInSeconds: SIGNUP_TOKEN_SECONDS };
  }

  /** Mirrors POST /auth/signup, plus the verified phone. */
  async completeSignup(dto: OtpSignupDto) {
    const claims = await this.tokens.verify(dto.signupToken, 'phone_signup');
    if (!claims) throw otpError('SIGNUP_SESSION_INVALID');
    const phone = claims.phone;
    if (await this.users.findByUsername(dto.username))
      throw new HttpException(
        { statusCode: HttpStatus.BAD_REQUEST, error: 'EMAIL_IN_USE', message: 'Account already exists with this email!, go to login' },
        HttpStatus.BAD_REQUEST,
      );
    if (await this.users.phoneOwnerId(phone)) throw otpError('PHONE_IN_USE');

    let user;
    try {
      user = await this.users.create({
        username: dto.username,
        password: dto.password,
        firstName: dto.firstName,
        lastName: dto.lastName,
        age: dto.age,
        gender: dto.gender,
        phoneNumber: phone,
        roles: [ERole.USER],
        isEmailVerified: false,
        passwordResetToken: undefined,
        passwordResetTokenUsed: false,
        displayname: dto.username.split('@')[0],
        phoneE164: phone,
        phoneVerifiedAt: new Date(),
      } as any);
    } catch (error) {
      if (error?.code === 11000 && error?.keyPattern?.phoneE164) throw otpError('PHONE_IN_USE');
      throw error;
    }

    const sent = await this.mail.verifyAccount(user.username, user.firstName);
    // Same development behaviour as /auth/signup: no SES, no verification email.
    if (!process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET || !process.env.AWS_SES_REGION)
      await this.users.updateOne(user._id.toString(), { isEmailVerified: true });
    this.logger.log({ event: 'otp_signup_created', phone: maskPhone(phone) });

    const created = await this.users.findByUsername(dto.username);
    if (!created?.isEmailVerified)
      return {
        emailVerificationRequired: true,
        message: sent
          ? 'Account created. Verify your email, then sign in with your phone number.'
          : 'Account created, but the verification email could not be sent. Contact support.',
      };
    return { emailVerificationRequired: false, ...(await this.signIn(created)) };
  }

  /** One-time password sign-in for existing users who have no verified phone yet. */
  async bootstrap(username: string, password: string, ip: string) {
    await this.throttle.consume([
      { key: throttleKey('bootstrap-ip', ip), limit: this.throttle.limits.passwordPerIp10m, windowSeconds: TEN_MINUTES },
      { key: throttleKey('bootstrap-user', username.toLowerCase()), limit: 10, windowSeconds: TEN_MINUTES },
    ]);
    // Throws the same 401 for unknown accounts and wrong passwords.
    await this.auth.validateUser(username, password);
    const user = await this.users.findByUsername(username);
    if (!user) throw new UnauthorizedException('Invalid username or password');
    this.assertCanSignIn(user);
    if (user.phoneVerifiedAt) throw otpError('PHONE_ALREADY_LINKED');
    const bootstrapToken = await this.tokens.sign(
      { scope: 'phone_bootstrap', sub: String(user._id) },
      BOOTSTRAP_TOKEN_SECONDS,
    );
    return { bootstrapToken, expiresInSeconds: BOOTSTRAP_TOKEN_SECONDS };
  }

  async sendLinkCode(input: string, ip: string) {
    const phone = this.phone(input);
    await this.deliver(phone, ip, { send: true, quiet: false });
    return { resendAfterSeconds: this.throttle.limits.resendCooldownSeconds };
  }

  /** Adds or changes the account's phone after a fresh OTP to the new number. */
  async verifyLink(actor: { id: string; authMethod?: string }, input: string, code: string, ip: string) {
    const phone = this.phone(input);
    await this.limitChecks(phone, ip);
    await this.approve(phone, code);
    if (!(await this.users.setVerifiedPhone(actor.id, phone))) throw otpError('PHONE_IN_USE');
    this.logger.log({ event: 'otp_phone_linked', phone: maskPhone(phone) });
    // Settings changes keep the current session; clients refresh /auth/me.
    if (actor.authMethod !== 'phone_bootstrap') return { phoneE164: phone };
    // Bootstrap ends in a real phone session.
    const user = await this.users.findOne({ _id: actor.id });
    if (!user) throw new UnauthorizedException('Account is unavailable');
    return this.signIn(user);
  }

  private phone(input: string): string {
    const phone = normalizePhone(input);
    if (!phone) throw otpError('PHONE_INVALID');
    return phone;
  }

  private async deliver(phone: string, ip: string, { send, quiet }: { send: boolean; quiet: boolean }) {
    if (!this.twilio.configured) throw otpError('OTP_UNAVAILABLE');
    const limits = this.throttle.limits;
    await this.throttle.consume([
      { key: throttleKey('send-ip', ip), limit: limits.sendPerIp10m, windowSeconds: TEN_MINUTES },
      { key: throttleKey('send-ip', ip), limit: limits.sendPerIpDay, windowSeconds: ONE_DAY },
    ]);
    await this.throttle.cooldown(throttleKey('send-cooldown', phone));
    await this.throttle.consume(
      [
        { key: throttleKey('send-phone', phone), limit: limits.sendPerPhone10m, windowSeconds: TEN_MINUTES },
        { key: throttleKey('send-phone', phone), limit: limits.sendPerPhoneDay, windowSeconds: ONE_DAY },
      ],
      'OTP_SEND_LIMIT',
    );
    if (!send) return;
    try {
      await this.twilio.send(phone);
    } catch (error) {
      // A login error for a registered number would reveal that it is registered.
      if (!quiet) throw error;
    }
  }

  private limitChecks(phone: string, ip: string) {
    const limits = this.throttle.limits;
    return this.throttle.consume([
      { key: throttleKey('verify-ip', ip), limit: limits.verifyPerIp10m, windowSeconds: TEN_MINUTES },
      { key: throttleKey('verify-phone', phone), limit: limits.verifyPerPhone10m, windowSeconds: TEN_MINUTES },
    ]);
  }

  private async approve(phone: string, code: string) {
    const status = await this.twilio.check(phone, code);
    if (status === 'approved') return;
    throw otpError(status === 'pending' ? 'OTP_INVALID' : 'OTP_EXPIRED');
  }

  private assertCanSignIn(user) {
    const fail = (message: string) =>
      new HttpException({ statusCode: HttpStatus.BAD_REQUEST, error: 'Bad Request', message }, HttpStatus.BAD_REQUEST);
    if (user.isBlocked)
      throw fail(
        user.blockedBy === EBlockedByEnum.SYSTEM
          ? 'Your account has been blocked by system, please try again after sometimes'
          : `You account has been blocked by ${user.blockedBy}!. Contact support team.`,
      );
    if (user.deletionRequestedAt || user.moderationSuspendedUntil > new Date())
      throw new UnauthorizedException('Account is unavailable');
    if (!user.isEmailVerified) throw fail(UNVERIFIED_EMAIL);
  }

  private async signIn(user) {
    this.assertCanSignIn(user);
    const { accessToken } = await this.auth.createTokens(user, 'otp');
    await this.users.updateLoginInfo(user._id);
    return { user, accessToken };
  }
}
