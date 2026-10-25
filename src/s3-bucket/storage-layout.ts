import { randomUUID } from 'crypto';

export type ResourceType = 'temp' | 'profile' | 'post' | 'event' | 'group' | 'vault' | 'chat';
/** Only constructed by backend resource handlers, never deserialized from a request. */
export interface ResourceContext {
  ownerId: string;
  resourceType: ResourceType;
  resourceId: string;
  requester?: string;
  conversationId?: string;
  messageId?: string;
}
const segment = (value: string) => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid server resource identifier');
  return value;
};

/** Allocate once, persist before writing, and reuse on retry. No filename/path parameter. */
export function allocateKey(context: ResourceContext, variant?: 1080 | 320) {
  const objectId = randomUUID();
  return { objectId, key: buildKey(context, objectId, variant) };
}
export function buildKey(context: ResourceContext, objectId: string, variant?: 1080 | 320) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(objectId))
    throw new Error('Object identifier must be a backend UUID');
  if (variant !== undefined && variant !== 1080 && variant !== 320) throw new Error('Invalid variant');
  if (variant !== undefined && (['vault', 'chat', 'temp'].includes(context.resourceType) || context.resourceType === 'group' && variant !== 320))
    throw new Error('Variant does not belong to this resource type');
  const owner = segment(context.ownerId), resource = segment(context.resourceId);
  const leaf = variant ? `${variant}.webp` : 'original.jpg';
  switch (context.resourceType) {
    case 'temp': return `temp/${owner}/${objectId}.jpg`;
    case 'profile': return `profile/${owner}/${objectId}/${leaf}`;
    case 'post': return `posts/${owner}/${resource}/${objectId}/${leaf}`;
    case 'event': return `events/${resource}/cover/${objectId}/${leaf}`;
    case 'group': return `groups/${resource}/icon/${objectId}/${leaf}`;
    case 'vault': return `vault/${owner}/${objectId}.jpg`;
    case 'chat': return `chat/${segment(context.conversationId || '')}/${segment(context.messageId || resource)}/${objectId}.jpg`;
    default: throw new Error('Unknown resource type');
  }
}
export function layoutReadMode() {
  const mode = process.env.STORAGE_LAYOUT_READ || 'canonical';
  if (mode !== 'legacy' && mode !== 'canonical') throw new Error('Invalid STORAGE_LAYOUT_READ');
  return mode;
}
/** Both readers support both layouts; rollback changes field preference, never reconstructs keys. */
export function storedKey(row: any): string | undefined {
  return layoutReadMode() === 'legacy' ? row.key || row.s3Key : row.s3Key || row.key;
}
export function bucketForKey(key: string, fallback: string) {
  return (/^(previews|profile|posts|videos|events|groups)\//.test(key)
    ? process.env.PHOTO_MEDIA_BUCKET : /^(temp|vault|chat|quarantine|reports)\//.test(key)
      ? process.env.PHOTO_PRIVATE_BUCKET : undefined) || fallback;
}
export function bindingFromRef(ownerId: string, ref: string): ResourceContext {
  const [type, resourceId, extra] = ref.split(':');
  const resourceType = ({ avatar: 'profile', post: 'post', event: 'event', group: 'group', chat: 'chat' } as const)[type];
  if (!resourceType || !resourceId || extra) throw new Error('Invalid server resource reference');
  segment(resourceId); segment(ownerId);
  return { ownerId, resourceType, resourceId };
}
export function matchesBinding(row: any, context: ResourceContext) {
  if (!context || (row.ownerId || row.owner) !== context.ownerId || (row.owner && row.owner !== context.ownerId)) return false;
  const prefix = context.resourceType === 'profile' ? 'avatar' : context.resourceType;
  if (row.ref && row.ref !== `${prefix}:${context.resourceId}`) return false;
  if (row.resourceType !== undefined || row.resourceId !== undefined)
    return row.resourceType === context.resourceType && row.resourceId === context.resourceId &&
      (context.resourceType !== 'chat' || (!row.conversationId || row.conversationId === context.conversationId) &&
        (!row.messageId || row.messageId === context.messageId));
  return row.ref === `${prefix}:${context.resourceId}`;
}
