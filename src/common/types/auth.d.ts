export type TAuthMethod = 'password' | 'otp';

export type TCreateToken = {
  accessToken: string;
  cookieToken: string;
};
