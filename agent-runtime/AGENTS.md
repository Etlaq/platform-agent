# AGENTS.md

Etlaq Next.js 16 template — Arabic-first, RTL, shadcn/ui, MongoDB.
This file is a living reference — rewrite or restructure it anytime the project outgrows it.

## Commands
```bash
bun install      # Install deps
bun dev          # Dev server (Turbopack)
bun run build    # Production build
bun start        # Start production
bun lint         # ESLint
```

## Rules

1. **Read before edit** — Always read a file before modifying it
2. **Semantic colors** — `bg-background`, `text-foreground`, `bg-primary`. Never `bg-white`, `text-black`, or raw hex/rgb
3. **RTL-safe** — `ps-`, `pe-`, `ms-`, `me-`, `start-`, `end-`. Never `pl-`, `pr-`, `ml-`, `mr-`, `left-`, `right-`
4. **Arabic-first** — Default is `lang="ar-SA" dir="rtl"`. Always provide both Arabic and English text
5. **Strict types** — No `any`. Type everything

## Architecture

**Provider order** in `app/layout.tsx`:
```
<html lang="ar-SA" dir="rtl">
  → ThemeProvider → LanguageProvider → {children} + <Toaster />
```
An inline script runs before React hydration to apply saved theme/direction (no flash).

**Fonts** — IBM Plex Sans Arabic (Arabic body), Geist Sans (English body), Newsreader (English headings), Geist Mono (code). Auto-switched via `html[lang]` in globals.css.

**Env** (`lib/env.ts`) — Zod-validated at runtime, silent during build. Required: `MONGODB_URI`, `DB_NAME`, `JWT_SECRET` (min 32 chars).

**DB** (`lib/mongodb.ts`) — Singleton with promise pooling. Always `await connectDB()` at the top of API routes.

**Colors** (`globals.css`) — OKLCH only. Every new token needs both `:root` and `.dark` values. Primary is purple `oklch(0.55 0.22 280)` / `oklch(0.7 0.2 280)`. The file also has 40+ animation keyframes, glassmorphism utils, gradient text, and skeleton loaders.

## Patterns

**Language:**
```tsx
const { t, isArabic, dir, setLanguage } = useLanguage(); // @/contexts/LanguageContext
<h1>{t('مرحباً', 'Hello')}</h1>
```

**Theme:**
```tsx
const { theme, isDark, toggleTheme, setTheme } = useTheme(); // @/contexts/ThemeContext
// 'light' | 'dark' | 'system' — toggleTheme() cycles all three
```

**shadcn/ui:**
```tsx
import { Button } from '@/components/ui/button';
// variant: default | secondary | outline | ghost | link | destructive
// size: default | xs | sm | lg | icon | icon-xs | icon-sm | icon-lg
```

**API route:**
```tsx
export async function POST(req: NextRequest) {
  await connectDB();
  const data = await req.json();
  return NextResponse.json(await Model.create(data), { status: 201 });
}
```

**Client component:**
```tsx
'use client';
toast.success('تم بنجاح');
toast.error('حدث خطأ');
```

## Design

Don't build generic-looking UI. Pick a direction and commit:

- **Typography** — Distinctive fonts, not Inter/Arial/Roboto. Pair a display font with a body font
- **Color** — Dominant color + sharp accents via CSS variables. Avoid timid, evenly-spread palettes
- **Motion** — One orchestrated page load with staggered `animation-delay` beats scattered micro-interactions. CSS animations or Framer Motion
- **Layout** — Asymmetry, overlap, grid-breaking, generous whitespace or controlled density
- **Texture** — Gradient meshes, noise, grain, layered transparencies. Not flat solid backgrounds

Maximalist = elaborate code. Minimalist = precise spacing and typography. Match effort to vision.

## Style

- Imports: `@/lib/x`, `@/components/x`
- Client components: `'use client'` at top
- Class merging: `cn()` from `@/lib/utils`
- Errors: `try/catch` → `console.error()` + `toast.error()`
- Touch targets: min 44px
- Task names: Arabic, plain language (`صفحة تسجيل الدخول` not `Add JWT auth with bcrypt`)

## MCPs

| Server | Purpose |
|--------|---------|
| `shadcn` | Install and manage shadcn/ui components |
| `magicui` | Animated components — text effects, backgrounds, interactions |
| `next-devtools` | Debug Next.js — errors, routes, build, cache |

## Project Docs

- **`DESIGN.md`** — Create this when initializing a new project. Document the chosen theme direction, color palette, typography, motion style, and layout philosophy. This is the design source of truth
- **`TODOS.md`** — Maintain a running list of pending work, known issues, and next steps. Keep it updated as tasks are completed or added

---

## Agent Notes

Write here when you find a recurring fix or gotcha — so you never get stuck on the same thing twice.

<!-- AGENTS_NOTES_START -->
<!-- AGENTS_NOTES_END -->
