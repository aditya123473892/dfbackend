import { z } from 'zod';
export const REPORT_CATEGORIES = [
  'harassment',
  'hate',
  'spam_scam',
  'fake_profile',
  'nudity_sexual',
  'violence_threat',
  'underage',
  'self_harm',
  'impersonation',
  'other',
] as const;
export const reportInput = z
  .object({
    targetType: z.enum([
      'user',
      'post',
      'comment',
      'chat_message',
      'chat_media',
      'group',
      'event',
    ]),
    targetId: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .toLowerCase(),
    messageId: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .toLowerCase()
      .optional(),
    category: z.enum(REPORT_CATEGORIES),
    details: z.string().max(500).optional(),
    childSafetySuspected: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.targetType === 'chat_media' && !value.messageId)
      ctx.addIssue({
        code: 'custom',
        path: ['messageId'],
        message: 'Message ID is required',
      });
    if (value.targetType !== 'chat_media' && value.messageId)
      ctx.addIssue({
        code: 'custom',
        path: ['messageId'],
        message: 'Message ID belongs only to chat media reports',
      });
  });
export type ReportInput = z.infer<typeof reportInput>;
/** Store plain text, escaped defensively for future staff HTML renderers. */
export function sanitizeReportText(text = '') {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
