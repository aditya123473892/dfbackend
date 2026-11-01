import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthUser } from 'src/common/decorators';
import { IAuthUser } from 'src/common/interfaces';
import { successRes } from 'src/common/interceptors';
import { LoginDto } from '../dtos';
import { OtpSignupDto, PasswordLoginDto, PhoneDto, SendOtpDto, VerifyOtpDto } from './otp.dto';
import { OtpService } from './otp.service';
import { PhoneLinkGuard } from './phone-link.guard';
import { isMobileClient, mobilePhoneAuthRequired } from 'src/common/guards/otp-session.guard';
import { otpError } from './otp-errors';

const clientIp = (req: Request) => req.ip || req.socket?.remoteAddress || 'unknown';

@ApiTags('Auth')
@Controller('auth')
export class OtpController {
  constructor(private readonly otp: OtpService) {}

  @Get('email/verify')
  async verifyEmail(@Query('token') token: string, @Res() res: Response) {
    await this.otp.verifyEmail(token);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.type('text/plain').send('Email verified. Return to DARKFANTASY and sign in.');
  }

  @Post('email/resend')
  async resendEmail(@Body() dto: PasswordLoginDto, @Req() req: Request) {
    return successRes(await this.otp.resendVerification(dto.identifier, dto.password, clientIp(req)));
  }

  @Post('password/login')
  async passwordLogin(@Body() dto: PasswordLoginDto, @Req() req: Request) {
    if (isMobileClient(req) && mobilePhoneAuthRequired()) throw otpError('PHONE_LOGIN_REQUIRED');
    return successRes(await this.otp.passwordLogin(dto.identifier, dto.password, clientIp(req)));
  }

  /** Generic response: never reveals whether the number belongs to an account. */
  @Post('otp/send')
  async send(@Body() { phone, purpose }: SendOtpDto, @Req() req: Request) {
    return successRes(
      await this.otp.sendCode(phone, purpose ?? 'login', clientIp(req)),
      'If this number can receive codes, a code has been sent.',
    );
  }

  /** Phone sign-in. Returns the same { user, accessToken } as POST /auth/login. */
  @Post('otp/verify')
  async verify(@Body() { phone, code }: VerifyOtpDto, @Req() req: Request) {
    return successRes(await this.otp.verifyLogin(phone, code, clientIp(req)));
  }

  /** Signup step 1 (after otp/send with purpose "signup"): proves the number. */
  @Post('otp/signup/verify')
  async verifySignup(@Body() { phone, code }: VerifyOtpDto, @Req() req: Request) {
    return successRes(await this.otp.verifySignup(phone, code, clientIp(req)));
  }

  /** Signup step 2: creates the account with the verified number. */
  @Post('otp/signup')
  async signup(@Body() dto: OtpSignupDto) {
    return successRes(await this.otp.completeSignup(dto));
  }

  /** Existing user without a verified phone: one password sign-in that can only add a phone. */
  @Post('phone/bootstrap')
  async bootstrap(@Body() { username, password }: LoginDto, @Req() req: Request) {
    return successRes(await this.otp.bootstrap(username, password, clientIp(req)));
  }

  /** Add or change the account's phone (session or bootstrap token). */
  @ApiBearerAuth()
  @UseGuards(PhoneLinkGuard)
  @Post('phone/send')
  async sendLink(@Body() { phone }: PhoneDto, @Req() req: Request) {
    return successRes(await this.otp.sendLinkCode(phone, clientIp(req)), 'Code sent.');
  }

  @ApiBearerAuth()
  @UseGuards(PhoneLinkGuard)
  @Post('phone/verify')
  async verifyLink(@Body() { phone, code }: VerifyOtpDto, @AuthUser() actor: IAuthUser, @Req() req: Request) {
    return successRes(await this.otp.verifyLink(actor, phone, code, clientIp(req)), 'Phone number verified.');
  }
}
