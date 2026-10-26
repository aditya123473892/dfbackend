export interface IAuthUser {
  id: string;
  username: string;
  roles: [string];
  /** 'otp' for phone sessions; 'password' for web sessions and tokens issued before OTP. */
  authMethod?: 'password' | 'otp' | 'phone_bootstrap';
}
