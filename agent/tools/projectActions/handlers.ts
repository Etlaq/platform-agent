import {
  detectProjectAction,
  rollbackRunAction,
  secretsReadEnvExampleAction,
  secretsStatusAction,
  secretsSyncEnvExampleAction,
  validateEnvAction,
} from './actions/coreActions'
import {
  addDependenciesAction,
  generateDrizzleMigrationAction,
  runInstallAction,
  runNextBuildAction,
  runTypecheckAction,
} from './actions/dependencyActions'
import { scaffoldAuthjsSupabaseDrizzleAction } from './actions/scaffoldAuthAction'
import { scaffoldCronSupabaseDailyAction } from './actions/scaffoldCronAction'
import type { ProjectAction, ProjectActionInputByAction } from './schemas'
import type { ProjectActionContext, ProjectActionHandler, ProjectActionHandlerMap } from './types'

function createActionHandler<A extends ProjectAction>(
  run: (context: ProjectActionContext, input: ProjectActionInputByAction<A>) => Promise<unknown> | unknown,
  options?: { requiresNextBun?: boolean }
): ProjectActionHandler {
  return {
    requiresNextBun: options?.requiresNextBun,
    run: (context, input) => run(context, input as ProjectActionInputByAction<A>),
  }
}

export const projectActionHandlers: ProjectActionHandlerMap = {
  detect_project: createActionHandler<'detect_project'>((context) => detectProjectAction(context)),
  secrets_status: createActionHandler<'secrets_status'>((context) => secretsStatusAction(context)),
  secrets_read_env_example: createActionHandler<'secrets_read_env_example'>((context) => secretsReadEnvExampleAction(context)),
  secrets_sync_env_example: createActionHandler(secretsSyncEnvExampleAction),
  add_dependencies: createActionHandler(addDependenciesAction, { requiresNextBun: true }),
  run_install: createActionHandler<'run_install'>((context) => runInstallAction(context), { requiresNextBun: true }),
  run_next_build: createActionHandler<'run_next_build'>((context) => runNextBuildAction(context), { requiresNextBun: true }),
  run_typecheck: createActionHandler<'run_typecheck'>((context) => runTypecheckAction(context), { requiresNextBun: true }),
  generate_drizzle_migration: createActionHandler(generateDrizzleMigrationAction, { requiresNextBun: true }),
  scaffold_authjs_supabase_drizzle: createActionHandler<'scaffold_authjs_supabase_drizzle'>(
    (context) => scaffoldAuthjsSupabaseDrizzleAction(context),
    { requiresNextBun: true }
  ),
  scaffold_cron_supabase_daily: createActionHandler<'scaffold_cron_supabase_daily'>((context) => scaffoldCronSupabaseDailyAction(context), {
    requiresNextBun: true,
  }),
  validate_env: createActionHandler<'validate_env'>((context) => validateEnvAction(context), { requiresNextBun: true }),
  rollback_run: createActionHandler(rollbackRunAction),
}
