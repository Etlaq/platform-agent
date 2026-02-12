# Etlaq Next.js Template

A minimal Next.js 16 template with RTL support, dark mode, and shadcn/ui components.

## Features

- **Next.js 16** with React 19 and Turbopack
- **RTL/LTR** with Arabic-first language toggle
- **Dark/Light mode** with system detection
- **shadcn/ui** component library
- **Tailwind CSS 4** with OKLCH colors
- **MongoDB** ready (Mongoose)
- **TypeScript** strict mode

## Quick Start

```bash
# Install
bun install

# Development
bun dev

# Build
bun run build

# Lint
bun lint
```

## Project Structure

```
app/
├── page.tsx              # Home page
├── layout.tsx            # Root layout
├── globals.css           # Theme & styles
├── error.tsx             # Error boundary
components/
├── ThemeToggle.tsx       # Dark/light mode dropdown
├── LanguageToggle.tsx    # AR/EN toggle
├── ui/                   # shadcn/ui components
contexts/
├── LanguageContext.tsx   # RTL/LTR state
├── ThemeContext.tsx      # Theme state (light/dark/system)
lib/
├── mongodb.ts            # Database connection
├── utils.ts              # Utilities
```

## Usage

### Language Toggle

```tsx
import { useLanguage } from '@/contexts/LanguageContext';

const { t, isArabic } = useLanguage();

<h1>{t('مرحبا', 'Hello')}</h1>
```

### Theme Toggle

```tsx
import { ThemeToggle } from '@/components/ThemeToggle';
import { useTheme } from '@/contexts/ThemeContext';

<ThemeToggle />

// Or use the hook directly
const { theme, setTheme, isDark } = useTheme();
setTheme('dark'); // 'light' | 'dark' | 'system'
```

### shadcn/ui Components

```tsx
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

<Button variant="default">Click me</Button>
<Card>
  <CardHeader><CardTitle>Title</CardTitle></CardHeader>
  <CardContent>Content</CardContent>
</Card>
```

## Environment

```env
MONGODB_URI=mongodb+srv://...
DB_NAME=your_db_name
```

## Documentation

- See `CLAUDE.md` for development guidelines
- See [shadcn/ui Docs](https://ui.shadcn.com) for components
- See [Next.js Docs](https://nextjs.org/docs) for framework

---

**Built by Etlaq Studio**
