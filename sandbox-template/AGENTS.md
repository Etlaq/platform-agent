# AGENTS.md

Quick reference for Claude Code subagents. See `CLAUDE.md` for full guidelines.

## Commands
```bash
bun dev          # Dev server (Turbopack)
bun run build    # Production build
bun lint         # ESLint
```

## Stack
Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 (OKLCH) · shadcn/ui · MongoDB/Mongoose

## Critical Rules

1. **Read before edit** - Never modify files without reading them first
2. **Semantic colors only** - Use `bg-background`, `text-foreground`, never `bg-white`, `text-black`
3. **RTL-safe classes** - Use `ps-`, `pe-`, `ms-`, `me-`, `start`, `end` (never `pl-`, `pr-`, `left-`, `right-`)
4. **Arabic-first content** - Always provide both Arabic and English; Arabic is the default
5. **No `any` types** - Use proper TypeScript types

## shadcn/ui Button Variants
```tsx
import { Button } from '@/components/ui/button';
// variant: default | secondary | outline | ghost | link | destructive
// size: default | xs | sm | lg | icon | icon-xs | icon-sm | icon-lg
```

## Context Hooks
```tsx
const { t, isArabic, dir, setLanguage } = useLanguage();  // from @/contexts/LanguageContext
const { theme, isDark, toggleTheme, setTheme } = useTheme(); // from @/contexts/ThemeContext
```

## File Structure
```
app/page.tsx, layout.tsx, globals.css, error.tsx, loading.tsx
components/ThemeToggle, LanguageToggle, ui/
contexts/LanguageContext.tsx, ThemeContext.tsx
lib/mongodb.ts, utils.ts, env.ts
```

## Code Style
- Absolute imports: `@/lib/x`, `@/components/x`
- Client components: `'use client'` at top
- Class merging: `cn()` from `@/lib/utils`
- Error handling: try/catch with `console.error` + `toast.error()`
- Touch targets: minimum 44px
