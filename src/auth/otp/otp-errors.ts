import { HttpException, HttpStatus } from '@nestjs/common';

/** Stable machine-readable codes; clients branch on `error`, never on `message`. */
export const OTP_ERRORS = {
  PHONE_INVALID: [HttpStatus.BAD_REQUEST, 'Enter a valid mobile number.'],
  PHONE_UNSUPPORTED: [HttpStatus.BAD_REQUEST, "This number can't receive verification codes. Try another number."],
  OTP_COOLDOWN: [HttpStatus.TOO_MANY_REQUESTS, 'Please wait before requesting another code.'],
  OTP_RATE_LIMITED: [HttpStatus.TOO_MANY_REQUESTS, 'Too many attempts. Please try again later.'],
  OTP_SEND_LIMIT: [HttpStatus.TOO_MANY_REQUESTS, 'Too many codes requested for this number. Please try again later.'],
  OTP_CHECK_LIMIT: [HttpStatus.TOO_MANY_REQUESTS, 'Too many incorrect codes. Request a new code.'],
  OTP_INVALID: [HttpStatus.BAD_REQUEST, 'That code is incorrect. Check the SMS and try again.'],
  OTP_EXPIRED: [HttpStatus.BAD_REQUEST, 'That code has expired. Request a new code.'],
  PHONE_IN_USE: [HttpStatus.CONFLICT, 'This phone number is already linked to another account.'],
  PHONE_ALREADY_LINKED: [HttpStatus.CONFLICT, 'Your account already has a verified phone. Sign in with your phone number.'],
  PHONE_LOGIN_REQUIRED: [HttpStatus.FORBIDDEN, 'The mobile app uses phone number sign-in.'],
  SIGNUP_SESSION_INVALID: [HttpStatus.BAD_REQUEST, 'Your phone verification expired. Verify your number again.'],
  OTP_UNAVAILABLE: [HttpStatus.SERVICE_UNAVAILABLE, 'Phone verification is temporarily unavailable. Please try again later.'],
} as const satisfies Record<string, readonly [HttpStatus, string]>;

export type OtpErrorCode = keyof typeof OTP_ERRORS;

/** Serialized by GlobalExceptionFilter as { statusCode, error: code, message }. */
export function otpError(code: OtpErrorCode, message?: string): HttpException {
  const [status, fallback] = OTP_ERRORS[code];
  return new HttpException({ statusCode: status, error: code, message: message ?? fallback }, status);
}
