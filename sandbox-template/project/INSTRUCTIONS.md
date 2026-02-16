# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Etlaq Studio - Next.js 16 Template | Arabic-first, shadcn/ui, MongoDB

## Commands
```bash
bun dev          # Dev server (Turbopack)
bun run build    # Production build
bun start        # Run production server
bun lint         # ESLint
```

## Stack
Next.js 16 (React 19) · Tailwind CSS 4 (OKLCH) · shadcn/ui · MongoDB/Mongoose · framer-motion

## Architecture

### Provider Nesting (app/layout.tsx)
```
<html lang="ar-SA" dir="rtl">  ← Arabic-first default
  <ThemeProvider>
    <LanguageProvider>
      {children}
      <Toaster />               ← sonner toast notifications
    </LanguageProvider>
  </ThemeProvider>
</html>
```
A hydration-safe inline script runs before React to set the theme class and language attributes, preventing flash of wrong theme/direction.

### Fonts (loaded in layout.tsx)
| Font | Use |
|------|-----|
| IBM Plex Sans Arabic | Arabic body text (default) |
| Geist Sans | English body text |
| Newsreader | English headings |
| Geist Mono | Monospace |

Font switching is handled via CSS selectors on `html[lang]` in globals.css.

### Environment Variables (lib/env.ts)
Validated with Zod at runtime. Tolerates missing vars during build. Key vars:
```env
MONGODB_URI=mongodb+srv://...
DB_NAME=etlaq
JWT_SECRET=...
```

### Database Connection (lib/mongodb.ts)
Uses global singleton with promise pooling to prevent multiple connections during hot reload. Call `connectDB()` at the start of API routes.

## MCP Servers

| MCP | Use For |
|-----|---------|
| `shadcn` | Search, install, and manage shadcn/ui components |
| `magicui` | Animated components: text effects, backgrounds, interactions |
| `next-devtools` | Next.js debugging: errors, routes, build status, cache |

## Task Todos (Arabic)
Write task subjects in Arabic, simple language, no technical terms:
- `صفحة تسجيل الدخول` not `Add JWT auth with bcrypt`
- `إصلاح مشكلة الألوان` not `Update OKLCH variables`

## Workflow

### 1. Read First, Code Second
- **ALWAYS read files before editing**
- Check existing patterns before creating new ones
- Batch parallel tool calls when independent

### 2. UI Tasks → MCPs
- **Animated/Advanced UI**: Use Magic UI MCP (`mcp__magicui__*`)
- **Base components**: Use shadcn MCP (`mcp__shadcn__*`)

### 3. Theme Colors in globals.css
All colors use OKLCH. Add new tokens to both `:root` and `.dark` blocks.

| Token | Light | Dark |
|-------|-------|------|
| `--primary` | `oklch(0.55 0.22 280)` | `oklch(0.7 0.2 280)` |
| `--background` | `oklch(0.985 0 0)` | `oklch(0.10 0 0)` |
| `--foreground` | `oklch(0.15 0 0)` | `oklch(0.92 0 0)` |

### 4. Arabic-First
- Always provide both Arabic and English content; Arabic is the default
- Default: `lang="ar-SA"`, `dir="rtl"`

## Design Rules

### Semantic Tokens Only
```tsx
// ❌ bg-white text-black
// ✅ bg-background text-foreground
```

### RTL-Safe Classes
| Use | Avoid |
|-----|-------|
| `ps-4`, `pe-4`, `ms-4`, `me-4` | `pl-4`, `pr-4`, `ml-4`, `mr-4` |
| `start-6`, `end-6` | `left-6`, `right-6` |

## Key Patterns

### Language Context
```tsx
const { t, isArabic, setLanguage, dir } = useLanguage();
<h1>{t('مرحباً', 'Hello')}</h1>
{isArabic ? <ArrowLeft /> : <ArrowRight />}
```

### Theme Context
```tsx
const { theme, setTheme, isDark, toggleTheme } = useTheme();
// theme: 'light' | 'dark' | 'system'
// toggleTheme() cycles: light → dark → system → light
```

### API Route
```tsx
export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const data = await request.json();
    return NextResponse.json(await Model.create(data), { status: 201 });
  } catch (error) {
    console.error('Failed:', error);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
```

### Client Component with Toast
```tsx
'use client';
import { toast } from 'sonner';

const handleAction = async () => {
  setLoading(true);
  try {
    await doSomething();
    toast.success('تم بنجاح');
  } catch (err) {
    console.error(err);
    toast.error('حدث خطأ');
  } finally {
    setLoading(false);
  }
};
```

## Specialized Agents
| Agent | Use For |
|-------|---------|
| `auth-specialist` | JWT, protected routes |
| `database-specialist` | MongoDB schemas, queries |
| `api-integration-specialist` | External APIs, webhooks |
| `quality-specialist` | Code review, security |

For UI tasks, use **Magic UI MCP** for animations/effects, **shadcn MCP** for base components.
