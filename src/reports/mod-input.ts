import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { sanitizeReportText } from './report-input';
const note = z.string().trim().min(1).max(500).transform(sanitizeReportText);
const revision = z.number().int().min(0);
// 'actioned' is reachable only through /actions, so a case can never be closed
// as a policy violation (and notify the target) without an enforcement action.
export const transitionInput = z.object({ status: z.enum(['in_review', 'dismissed', 'escalated']), revision, note }).strict();
export const actionInput = z.object({ action: z.enum(['dismiss', 'warn', 'soft_remove', 'suspend', 'escalate', 'ban', 'delete_account']), revision, note,
  suspendedUntil: z.string().datetime().optional() }).strict();
export const assignInput = z.object({ moderatorId: z.string().regex(/^[a-f\d]{24}$/i), revision, note }).strict();
export const holdInput = z.object({ legalHold: z.boolean(), revision, note }).strict();
export const evidenceInput = z.object({ reason: z.literal('case_review') }).strict();
export function parseMod<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Invalid moderation request; a note and current revision are required');
  return result.data;
}
