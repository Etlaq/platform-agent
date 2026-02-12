import { z } from 'zod'

export const e2bToolSchema = z.object({
  code: z.string().min(1, 'Code is required'),
  language: z.string().optional().default('python'),
  timeoutMs: z.number().int().positive().optional(),
})

export type E2BToolInput = z.infer<typeof e2bToolSchema>
