import { createHmac } from 'crypto';
import {
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';

/** Country assumed when a number has no +country code (OTP_DEFAULT_COUNTRY, ISO 3166 alpha-2). */
export function defaultCountry(value = process.env.OTP_DEFAULT_COUNTRY): CountryCode {
  const code = String(value || 'IN').trim().toUpperCase();
  return isSupportedCountry(code) ? code : 'IN';
}

/** Returns the E.164 form ("+919876543210") or null when the input is not a valid number. */
export function normalizePhone(input: unknown, country = defaultCountry()): string | null {
  if (typeof input !== 'string' || input.length > 32) return null;
  const compact = input.trim().replace(/^00/, '+');
  if (!/^\+?[\d\s().-]{6,}$/.test(compact)) return null;
  const parsed = parsePhoneNumberFromString(compact, country);
  return parsed?.isValid() ? parsed.number : null;
}

/** Log-safe form: "+91*******10". Never log the full number. */
export function maskPhone(phone: string): string {
  if (!phone || phone.length < 6) return '***';
  return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 5)}${phone.slice(-2)}`;
}

/** Keyed digest so throttle rows never store raw phone numbers or IPs. */
export function throttleKey(kind: string, value: string): string {
  const digest = createHmac('sha256', process.env.JWT_SECRET || 'otp-throttle')
    .update(value)
    .digest('base64url')
    .slice(0, 22);
  return `${kind}:${digest}`;
}
