import { z } from 'zod'

export const actionEnum = z.enum([
  'detect_project',
  'secrets_status',
  'secrets_read_env_example',
  'secrets_sync_env_example',
  'add_dependencies',
  'run_install',
  'run_next_build',
  'run_typecheck',
  'generate_drizzle_migration',
  'scaffold_authjs_supabase_drizzle',
  'scaffold_cron_supabase_daily',
  'validate_env',
  'rollback_run',
])

export const depsSchema = z
  .array(
    z.object({
      name: z.string().min(1),
      version: z.string().optional(),
      dev: z.boolean().optional().default(false),
    })
  )
  .min(1)

// Tool schema must be a single JSON object schema for maximum provider compatibility.
// We validate action-specific fields with strictSchema inside the handler.
export const toolSchema = z
  .object({
    action: actionEnum,
    includeRecommended: z.boolean().optional(),
    deps: depsSchema.optional(),
    runInstall: z.boolean().optional(),
    name: z.string().min(1).max(64).optional(),
    confirm: z.literal('rollback').optional(),
    runId: z.string().min(1).optional(),
  })
  .strict()

export const strictSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('detect_project'),
  }),
  z.object({
    action: z.literal('secrets_status'),
  }),
  z.object({
    action: z.literal('secrets_read_env_example'),
  }),
  z.object({
    action: z.literal('secrets_sync_env_example'),
    includeRecommended: z.boolean().optional().default(false),
  }),
  z.object({
    action: z.literal('add_dependencies'),
    deps: depsSchema,
    runInstall: z.boolean().optional().default(false),
  }),
  z.object({
    action: z.literal('run_install'),
  }),
  z.object({
    action: z.literal('run_next_build'),
  }),
  z.object({
    action: z.literal('run_typecheck'),
  }),
  z.object({
    action: z.literal('generate_drizzle_migration'),
    name: z.string().min(1).max(64),
  }),
  z.object({
    action: z.literal('scaffold_authjs_supabase_drizzle'),
  }),
  z.object({
    action: z.literal('scaffold_cron_supabase_daily'),
  }),
  z.object({
    action: z.literal('validate_env'),
  }),
  z.object({
    action: z.literal('rollback_run'),
    confirm: z.literal('rollback'),
    runId: z.string().min(1),
  }),
])

export type ProjectAction = z.infer<typeof actionEnum>
export type ProjectActionInput = z.infer<typeof strictSchema>
export type ProjectActionInputByAction<A extends ProjectAction> = Extract<ProjectActionInput, { action: A }>
