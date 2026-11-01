/** Never start a production API with the repository's development secrets. */
export function validateBackendEnvironment(env: Record<string, any>) {
  if (env.NODE_ENV === 'production') {
    if (
      !/^mongodb(?:\+srv)?:\/\//.test(String(env.DATABASE_URL || '')) ||
      /<[^>]+>|%3Cdb_password%3E/i.test(String(env.DATABASE_URL || ''))
    )
      throw new Error(
        'Production DATABASE_URL must contain a complete MongoDB connection string; replace the password placeholder in the host secret settings',
      );
    for (const name of [
      'DATABASE_URL',
      'DATABASE_NAME',
      'AWS_SES_REGION',
      'AWS_MAIL_FROM',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_VERIFY_SERVICE_SID',
      'AWS_DEFAULT_S3_BUCKET',
    ])
      if (!String(env[name] || '').trim()) throw new Error(`Production ${name} is required`);
    if (!String(env.AWS_S3_REGION || env.AWS_REGION || '').trim())
      throw new Error('Production AWS region is required');
    for (const name of ['PUBLIC_API_URL', 'PUBLIC_SITE_DOMAIN']) {
      let url: URL;
      try {
        url = new URL(env[name]);
      } catch {
        throw new Error(`Production ${name} must be an HTTPS origin`);
      }
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw new Error(`Production ${name} must be an HTTPS origin`);
    }
    if (
      env.OTP_DEV_FAKE_CODE ||
      env.OTP_DEV_BYPASS_RATE_LIMITS === 'true' ||
      env.PHOTO_MODERATION_MODE === 'development-bypass' ||
      env.PHOTO_VERIFY_BUCKET_SETTINGS === 'false'
    )
      throw new Error('Development authentication/storage bypasses are forbidden in production');
    if (env.TRUST_PROXY && !/^\d+$/.test(String(env.TRUST_PROXY)))
      throw new Error('TRUST_PROXY must be the exact numeric count of trusted reverse proxy hops');
    const jwt = String(env.JWT_SECRET || '');
    const encryption = String(env.PASSWORD_ENCRYPTION_PRIVATE_KEY || '');
    if (jwt.length < 32 || /development|replace|change.me|example/i.test(jwt)) {
      throw new Error('A strong production JWT_SECRET is required');
    }
    if (
      !/^[a-fA-F0-9]{64}$/.test(encryption) ||
      /^(0123456789abcdef){4}$/.test(encryption) ||
      new Set(encryption).size < 8
    ) {
      throw new Error('A strong production PASSWORD_ENCRYPTION_PRIVATE_KEY is required');
    }
  }
  const port = Number(env.PORT || 9000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be a valid TCP port');
  if (env.EXPIRES_IN && !/^\d+(?:s|m|h|d)$/.test(String(env.EXPIRES_IN)))
    throw new Error('EXPIRES_IN must be a positive duration such as 15m, 1h or 7d');
  return env;
}
