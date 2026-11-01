import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * The Expo app sends this on every request, including web previews. It is a
 * client claim, never app attestation or a replacement for authentication.
 */
export const CLIENT_PLATFORM_HEADER = 'x-client-platform';

export function isMobileClient(req: { headers?: Record<string, unknown> }): boolean {
  const value = req?.headers?.[CLIENT_PLATFORM_HEADER];
  return typeof value === 'string' && value.trim().toLowerCase() === 'mobile';
}

/** Local email/password signup is available until phone authentication is enabled. */
export function mobilePhoneAuthRequired(): boolean {
  const setting = process.env.MOBILE_PHONE_AUTH_REQUIRED;
  return setting === 'true' || (setting !== 'false' && process.env.NODE_ENV === 'production');
}

/**
 * Mobile-only routes: require a session issued by phone OTP. Use after JwtAuthGuard.
 * Off until MOBILE_OTP_ONLY_ROUTES=on, so app builds released before OTP keep working
 * until they are retired.
 */
@Injectable()
export class OtpSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (process.env.MOBILE_OTP_ONLY_ROUTES !== 'on') return true;
    if (context.switchToHttp().getRequest().user?.authMethod === 'otp') return true;
    throw new HttpException(
      {
        statusCode: HttpStatus.FORBIDDEN,
        error: 'PHONE_LOGIN_REQUIRED',
        message: 'Sign in with your phone number in the mobile app to use this feature.',
      },
      HttpStatus.FORBIDDEN,
    );
  }
}
