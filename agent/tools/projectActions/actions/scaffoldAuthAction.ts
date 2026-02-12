import path from 'node:path'
import { pickCodeRoot, readJsonFile, writeJsonFile } from '../helpers/fileSystem'
import { upsertEnvExample } from '../helpers/envFiles'
import { writeFileWithRollback } from '../helpers/writeWithRollback'
import type { ProjectActionContext } from '../types'

interface PackageJsonShape {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

export async function scaffoldAuthjsSupabaseDrizzleAction(context: ProjectActionContext) {
  const codeRoot = pickCodeRoot(context.params.workspaceRoot)
  const isSrc = codeRoot.endsWith(path.sep + 'src')

  const deps: Array<{ name: string; dev: boolean; version?: string }> = [
    // Pin to next-auth v5 beta for App Router compatibility (npm "latest" is still v4).
    { name: 'next-auth', version: '5.0.0-beta.30', dev: false },
    { name: '@auth/drizzle-adapter', dev: false },
    { name: 'drizzle-orm', dev: false },
    { name: 'pg', dev: false },
    { name: '@types/pg', dev: true },
    { name: 'zod', dev: false },
    { name: 'drizzle-kit', dev: true },
  ]

  const depResult = await (async () => {
    const pkgPath = path.join(context.params.workspaceRoot, 'package.json')
    const pkg = readJsonFile<PackageJsonShape>(pkgPath)
    pkg.dependencies = pkg.dependencies ?? {}
    pkg.devDependencies = pkg.devDependencies ?? {}
    for (const dep of deps) {
      const version = dep.version ?? 'latest'
      if (dep.dev) pkg.devDependencies[dep.name] = pkg.devDependencies[dep.name] ?? version
      else pkg.dependencies[dep.name] = pkg.dependencies[dep.name] ?? version
    }
    context.params.rollback.recordBeforeChange(pkgPath, context.params.workspaceRoot)
    writeJsonFile(pkgPath, pkg)
    return { updated: 'package.json', deps }
  })()

  const envResult = upsertEnvExample(context.params.workspaceRoot, context.params.rollback, {
    DATABASE_URL: 'postgres://USER:PASSWORD@HOST:5432/DB',
    NEXTAUTH_URL: 'http://localhost:3000',
    NEXTAUTH_SECRET: 'changeme',
    GITHUB_ID: '',
    GITHUB_SECRET: '',
  })

  const drizzleConfig = `import { defineConfig } from "drizzle-kit";
import { env } from "./${isSrc ? 'src' : '.'}/env";

export default defineConfig({
  schema: "./${isSrc ? 'src/' : ''}db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
});
`

  writeFileWithRollback({
    workspaceRoot: context.params.workspaceRoot,
    rollback: context.params.rollback,
    relPath: 'drizzle.config.ts',
    content: drizzleConfig,
  })

  const envTs = `import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  NEXTAUTH_URL: z.string().min(1),
  NEXTAUTH_SECRET: z.string().min(1),
  GITHUB_ID: z.string().optional(),
  GITHUB_SECRET: z.string().optional(),
});

export const env = schema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
  GITHUB_ID: process.env.GITHUB_ID,
  GITHUB_SECRET: process.env.GITHUB_SECRET,
});
`

  writeFileWithRollback({
    workspaceRoot: context.params.workspaceRoot,
    rollback: context.params.rollback,
    relPath: path.relative(context.params.workspaceRoot, path.join(codeRoot, 'env.ts')),
    content: envTs,
  })

  const dbIndex = `import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../env";

declare global {
  // eslint-disable-next-line no-var
  var __dbPool: Pool | undefined;
}

const pool = globalThis.__dbPool ?? new Pool({ connectionString: env.DATABASE_URL });
globalThis.__dbPool = pool;

export const db = drizzle(pool);
`

  writeFileWithRollback({
    workspaceRoot: context.params.workspaceRoot,
    rollback: context.params.rollback,
    relPath: path.relative(context.params.workspaceRoot, path.join(codeRoot, 'db', 'index.ts')),
    content: dbIndex,
  })

  const schemaTs = `import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

export const users = pgTable("user", {
  id: text("id").primaryKey().notNull(),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: timestamp("expires_at", { mode: "date" }),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => ({
    compoundKey: primaryKey({ columns: [account.provider, account.providerAccountId] }),
  })
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey().notNull(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => ({
    compoundKey: primaryKey({ columns: [vt.identifier, vt.token] }),
  })
);
`

  writeFileWithRollback({
    workspaceRoot: context.params.workspaceRoot,
    rollback: context.params.rollback,
    relPath: path.relative(context.params.workspaceRoot, path.join(codeRoot, 'db', 'schema.ts')),
    content: schemaTs,
  })

  const authTs = `import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "./db";
import { env } from "./env";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db),
  providers: [
    GitHub({
      clientId: env.GITHUB_ID ?? "",
      clientSecret: env.GITHUB_SECRET ?? "",
    }),
  ],
});
`

  writeFileWithRollback({
    workspaceRoot: context.params.workspaceRoot,
    rollback: context.params.rollback,
    relPath: path.relative(context.params.workspaceRoot, path.join(codeRoot, 'auth.ts')),
    content: authTs,
  })

  if (context.detection.router === 'app') {
    const routeTs = `import { handlers } from "../../../../auth";

export const { GET, POST } = handlers;
`
    const apiPath = path.join(codeRoot, 'app', 'api', 'auth', '[...nextauth]', 'route.ts')
    writeFileWithRollback({
      workspaceRoot: context.params.workspaceRoot,
      rollback: context.params.rollback,
      relPath: path.relative(context.params.workspaceRoot, apiPath),
      content: routeTs,
    })
  } else if (context.detection.router === 'pages') {
    // Pages Router support varies by NextAuth version; keep the scaffold minimal and app-router friendly.
  }

  const middleware = `export { auth as middleware } from "${isSrc ? './src/auth' : './auth'}";

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
`

  writeFileWithRollback({
    workspaceRoot: context.params.workspaceRoot,
    rollback: context.params.rollback,
    relPath: 'middleware.ts',
    content: middleware,
  })

  return {
    deps: depResult,
    env: envResult,
    touchedFiles: context.params.rollback.getTouchedFiles(),
    note:
      context.detection.router === 'pages'
        ? 'Scaffolded Auth.js + Drizzle + Postgres (Supabase-compatible). Pages Router detected; you may need to wire the NextAuth API route manually or migrate to App Router.'
        : 'Scaffolded Auth.js (next-auth v5 beta) + Drizzle + Postgres (Supabase-compatible). Run migrations with drizzle-kit.',
  }
}
