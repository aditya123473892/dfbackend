/** Only for outward-facing post reads, never for a document that will be saved.
 * Population uses the shared query plugin before fetching child rows. */
export function visiblePostQuery<
  T extends { populate: (...args: any[]) => any },
>(query: T): T {
  query.populate({
    path: 'likes',
    select: 'user',
    populate: { path: 'user', select: 'displayname avatar' },
  });
  query.populate({
    path: 'comments',
    select: 'content user createdAt',
    populate: { path: 'user', select: 'displayname avatar' },
  });
  return query;
}
