import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Twilio } from 'twilio';
import { maskPhone } from './phone';
import { otpError } from './otp-errors';

export type VerifyCheckStatus = 'approved' | 'pending' | 'canceled' | 'expired' | string;

/** Twilio Verify error codes -> API errors. https://www.twilio.com/docs/api/errors */
export function mapTwilioError(error: any): HttpException {
  const code = Number(error?.code);
  if ([60200, 21211, 21614].includes(code)) return otpError('PHONE_INVALID');
  // Landline, unsubscribed, blocked prefix/geo, fraud guard, trial-unverified destination.
  if ([60205, 21610, 60410, 60605, 60220, 21408, 21608].includes(code)) return otpError('PHONE_UNSUPPORTED');
  if (code === 60203) return otpError('OTP_SEND_LIMIT');
  if (code === 60202) return otpError('OTP_CHECK_LIMIT');
  // No pending verification: it expired (10 min), was already approved, or was never sent.
  if (code === 20404) return otpError('OTP_EXPIRED');
  if (code === 20429 || error?.status === 429) return otpError('OTP_RATE_LIMITED');
  return otpError('OTP_UNAVAILABLE');
}

/** Thin wrapper over Twilio Verify; credentials stay server-side and are never logged. */
@Injectable()
export class TwilioVerifyClient {
  private readonly client?: Twilio;
  private readonly serviceSid?: string;
  // TEMPORARY DEV-ONLY fake OTP (revert: delete `fakeCode` and its three uses).
  // With OTP_DEV_FAKE_CODE set and no Twilio credentials, no SMS is sent and only
  // that code verifies. Refused outright in production.
  private readonly fakeCode?: string;

  constructor(config: ConfigService) {
    const accountSid = config.get<string>('TWILIO_ACCOUNT_SID');
    const authToken = config.get<string>('TWILIO_AUTH_TOKEN');
    this.serviceSid = config.get<string>('TWILIO_VERIFY_SERVICE_SID');
    if (accountSid && authToken && this.serviceSid)
      this.client = new Twilio(accountSid, authToken, { autoRetry: true, maxRetries: 2 });
    const fake = config.get<string>('OTP_DEV_FAKE_CODE');
    if (fake) {
      if (process.env.NODE_ENV === 'production')
        throw new Error('OTP_DEV_FAKE_CODE must never be set in production');
      if (!/^\d{6}$/.test(fake)) throw new Error('OTP_DEV_FAKE_CODE must be 6 digits');
      if (!this.client) {
        this.fakeCode = fake;
        Logger.warn('FAKE OTP ENABLED: no SMS is sent; use OTP_DEV_FAKE_CODE', 'TwilioVerifyClient');
      }
    }
  }

  get configured(): boolean {
    return Boolean(this.client || this.fakeCode);
  }

  async send(to: string): Promise<void> {
    if (this.fakeCode) {
      Logger.warn({ event: 'otp_fake_send', phone: maskPhone(to) }, 'TwilioVerifyClient');
      return;
    }
    try {
      await this.service().verifications.create({ to, channel: 'sms' });
    } catch (error) {
      throw this.failure('send', to, error);
    }
  }

  async check(to: string, code: string): Promise<VerifyCheckStatus> {
    if (this.fakeCode) return code === this.fakeCode ? 'approved' : 'pending';
    try {
      return (await this.service().verificationChecks.create({ to, code })).status;
    } catch (error) {
      throw this.failure('check', to, error);
    }
  }

  private service() {
    if (!this.client) throw otpError('OTP_UNAVAILABLE');
    return this.client.verify.v2.services(this.serviceSid);
  }

  private failure(operation: string, to: string, error: any): HttpException {
    if (error instanceof HttpException) return error;
    Logger.warn(
      { event: 'otp_twilio_failed', operation, phone: maskPhone(to), status: error?.status, code: error?.code },
      'TwilioVerifyClient',
    );
    return mapTwilioError(error);
  }
}
