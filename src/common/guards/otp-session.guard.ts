import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * The Expo app sends this on every request. Browsers cannot: CORS does not allow
 * the header, so a web page never reaches the mobile-only branches. Native clients
 * can forge or omit it; see README "Phone OTP sign-in" for what that does and does not allow.
 */
export const CLIENT_PLATFORM_HEADER = 'x-client-platform';

export function isMobileClient(req: { headers?: Record<string, unknown> }): boolean {
  const value = req?.headers?.[CLIENT_PLATFORM_HEADER];
  return typeof value === 'string' && value.trim().toLowerCase() === 'mobile';
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
