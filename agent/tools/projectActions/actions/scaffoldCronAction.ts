import path from 'node:path'
import { upsertEnvExample } from '../helpers/envFiles'
import { fileExists, readJsonFile, writeJsonFile, pickCodeRoot } from '../helpers/fileSystem'
import { writeFileWithRollback } from '../helpers/writeWithRollback'
import type { ProjectActionContext } from '../types'

interface TsConfigShape {
  exclude?: string[]
  [key: string]: unknown
}

export function scaffoldCronSupabaseDailyAction(context: ProjectActionContext) {
  const codeRoot = pickCodeRoot(context.params.workspaceRoot)

  const envResult = upsertEnvExample(context.params.workspaceRoot, context.params.rollback, {
    CRON_SECRET: 'changeme',
    CRON_TARGET_URL: 'http://localhost:3000',
  })

  const jobRel = path.relative(context.params.workspaceRoot, path.join(codeRoot, 'jobs', 'daily.ts'))
  writeFileWithRollback({
    workspaceRoot: context.params.workspaceRoot,
    rollback: context.params.rollback,
    relPath: jobRel,
    content: `export async function runDailyJob() {
  // TODO: implement your daily job
  return { ok: true, ts: new Date().toISOString() };
}
`,
  })

  const endpointRel =
    context.detection.router === 'pages'
      ? path.relative(context.params.workspaceRoot, path.join(codeRoot, 'pages', 'api', 'cron', 'daily.ts'))
      : path.relative(context.params.workspaceRoot, path.join(codeRoot, 'app', 'api', 'cron', 'daily', 'route.ts'))

  const endpointAbs = path.join(context.params.workspaceRoot, endpointRel)
  const jobAbs = path.join(context.params.workspaceRoot, jobRel)
  const importFromEndpointToJob = path
    .relative(path.dirname(endpointAbs), jobAbs)
    .replace(/\\/g, '/')
    .replace(/\.tsx?$/, '')

  const jobImport = importFromEndpointToJob.startsWith('.') ? importFromEndpointToJob : `./${importFromEndpointToJob}`

  const endpointContent =
    context.detection.router === 'pages'
      ? `import type { NextApiRequest, NextApiResponse } from "next";
import { runDailyJob } from "${jobImport}";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = req.headers["x-cron-secret"];
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const result = await runDailyJob();
  return res.status(200).json(result);
}
`
      : `import { NextResponse } from "next/server";
import { runDailyJob } from "${jobImport}";

export async function POST(req: Request) {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runDailyJob();
  return NextResponse.json(result);
}
`

  writeFileWithRollback({
    workspaceRoot: context.params.workspaceRoot,
    rollback: context.params.rollback,
    relPath: endpointRel,
    content: endpointContent,
  })

  const edgeFnRel = path.join('supabase', 'functions', 'daily-cron', 'index.ts')
  writeFileWithRollback({
    workspaceRoot: context.params.workspaceRoot,
    rollback: context.params.rollback,
    relPath: edgeFnRel,
    content: `// Supabase Edge Function (Deno) that calls your Next.js cron endpoint.
// Deploy with: supabase functions deploy daily-cron
// Schedule it from Supabase (dashboard) to run daily.

const CRON_TARGET_URL = Deno.env.get("CRON_TARGET_URL")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

Deno.serve(async () => {
  const res = await fetch(\`${'${CRON_TARGET_URL}'}/api/cron/daily\`, {
    method: "POST",
    headers: {
      "x-cron-secret": CRON_SECRET,
    },
  });
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
});
`,
  })

  const configPath = path.join(context.params.workspaceRoot, 'supabase', 'config.toml')
  if (!fileExists(configPath)) {
    writeFileWithRollback({
      workspaceRoot: context.params.workspaceRoot,
      rollback: context.params.rollback,
      relPath: path.relative(context.params.workspaceRoot, configPath),
      content: `# Supabase local config placeholder.
# Scheduling is typically configured in the Supabase dashboard for Edge Functions.
# This file is created so the repo has a canonical supabase/ root.
`,
    })
  }

  // Next.js typechecking will often traverse all TS files; Supabase Edge Functions are Deno runtime.
  // Exclude them from the app's tsconfig to keep `next build` green.
  const tsconfigPath = path.join(context.params.workspaceRoot, 'tsconfig.json')
  if (fileExists(tsconfigPath)) {
    try {
      const tsconfig = readJsonFile<TsConfigShape>(tsconfigPath)
      const exclude = Array.isArray(tsconfig.exclude) ? tsconfig.exclude.slice() : []
      if (!exclude.includes('supabase/functions')) {
        exclude.push('supabase/functions')
        tsconfig.exclude = exclude
        context.params.rollback.recordBeforeChange(tsconfigPath, context.params.workspaceRoot)
        writeJsonFile(tsconfigPath, tsconfig)
      }
    } catch {
      // Ignore tsconfig parse failures; don't block scaffolding.
    }
  }

  return {
    env: envResult,
    touchedFiles: context.params.rollback.getTouchedFiles(),
    note: 'Scaffolded daily cron endpoint + Supabase Edge Function stub. Configure schedule in Supabase.',
  }
}
