import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
export const photoId = z.string().uuid();
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
export const uploadInput = z.object({ id: photoId, hidden: z.boolean().default(true), order: z.number().int().min(0).max(10000).default(0), updatedAt: timestamp,
  // Videos are stored byte-for-byte; the client-computed MD5 lets devices verify downloads.
  kind: z.enum(['photo', 'video']).optional(),
  contentType: z.enum(['video/mp4', 'video/quicktime']).optional(),
  size: z.number().int().positive().max(200 * 1024 * 1024).optional(),
  md5: z.string().regex(/^[a-f0-9]{32}$/).optional() }).strict()
  .refine(v => v.kind === 'video' ? !!(v.contentType && v.size && v.md5) : !v.contentType && !v.size && !v.md5);
export const confirmInput = z.object({ id: photoId }).strict();
export const editInput = z.object({ hidden: z.boolean().optional(), order: z.number().int().min(0).max(10000).optional(), updatedAt: timestamp }).strict();
export const deleteInput = z.object({ updatedAt: timestamp }).strict();
export const cursorInput = z.string().max(36).refine(v => v === '' || photoId.safeParse(v).success);
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Invalid vault request');
  return result.data;
}
