/** Deliberately usable only against a local database explicitly named *_dev or *_test. */
export function assertLocalEntitlementDevelopment(env: Record<string, string | undefined>) {
  if (env.NODE_ENV !== 'development' || !/_(dev|test)$/.test(env.DATABASE_NAME || ''))
    throw new Error('Test entitlements require development and a local *_dev or *_test database');
  const uri = env.DATABASE_URL || '';
  if (!/^mongodb:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?(?:\?[^#]*)?$/.test(uri))
    throw new Error('Test entitlements require a single unauthenticated loopback MongoDB host');
  // Refuse discovery/forwarding options that could redirect the driver elsewhere.
  const query = uri.split('?')[1];
  if (query && [...new URLSearchParams(query).keys()].some(key => !['directConnection'].includes(key)))
    throw new Error('MongoDB discovery options are unavailable for test entitlements');
}
