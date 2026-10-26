/** Public social profile contract. Add fields deliberately; never spread a user document. */
export const PUBLIC_PROFILE_FIELDS = new Set([
  '_id', 'displayname', 'firstName', 'lastName', 'avatar', 'bio', 'gender', 'age',
  'posts', 'followers', 'following', 'intrests', 'city', 'state', 'country',
  'isOnline', 'lastSeen', 'createdAt', 'usersPost',
]);

export function publicProfile(source: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => PUBLIC_PROFILE_FIELDS.has(key)));
}
