export enum EBlockedByEnum {
  OPEN = 'open',
  ADMIN = 'admin',
  SYSTEM = 'system',
}

export enum EAccountStatus {
  'OPEN' = 'open',
  'BLOCKED' = 'blocked',
}

export enum EGroupByYearOptions {
  YEAR = 'yearly',
  MONTH = 'monthly',
  WEEK = 'weekly',
}

export enum ETemplateEmail {
  TEST = 'test.email',
  VERIFY_ACCOUNT = 'verify-account.email',
  RESET_PASSWORD = 'reset-password.email',
  ACCOUNT_VERIFIED = 'account-verified.email',
  ACCOUNT_REJECT = 'account-reject.email',
  CREATE_EVENT = 'create-event.email',
  CREATE_SUBSCRIPTION = 'create-subscription-mail',
  LIMITED_MESSAGE= 'subscription-message-mail',
  CONTACT_MESSAGE= 'contact-message-mail',
  
}

export enum EContentType {
  PRIMARY = 'primary',
  SECONDARY = 'secondary',
}

export enum AccountStatus {
  BLOCKED = 'blocked',
  ACTIVE = 'active',
}

export enum EBrevoTemplateEmail {
  VERIFY_EMAIL = 1,
  RESET_PASSWORD = 2,
}

export enum S3Folder {
  AVATARS = 'avatars',
  POSTS = 'posts',
  EVENTS = 'events',
}
