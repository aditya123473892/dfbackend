/** Never start a production API with the repository's development secrets. */
export function validateBackendEnvironment(env: Record<string, any>) {
  if (env.NODE_ENV === 'production') {
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
      throw new Error(
        'A strong production PASSWORD_ENCRYPTION_PRIVATE_KEY is required',
      );
    }
  }
  return env;
}
