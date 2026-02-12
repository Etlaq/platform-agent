'use client';

import { Moon, Sun, Monitor, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTheme, type Theme } from '@/contexts/ThemeContext';
import { useLanguage } from '@/contexts/LanguageContext';

const themes: { value: Theme; icon: typeof Sun; labelAr: string; labelEn: string }[] = [
  { value: 'light', icon: Sun, labelAr: 'فاتح', labelEn: 'Light' },
  { value: 'dark', icon: Moon, labelAr: 'داكن', labelEn: 'Dark' },
  { value: 'system', icon: Monitor, labelAr: 'تلقائي', labelEn: 'System' },
];

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { t } = useLanguage();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="icon"
          className="rounded-full w-10 h-10 bg-background/80 backdrop-blur-sm border border-border/50 hover:bg-primary/5 hover:border-primary/30 transition-all duration-300 shadow-sm"
          aria-label={t('تغيير المظهر', 'Change theme')}
        >
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">{t('تغيير المظهر', 'Change theme')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[140px]">
        {themes.map(({ value, icon: ItemIcon, labelAr, labelEn }) => (
          <DropdownMenuItem
            key={value}
            onClick={() => setTheme(value)}
            className="flex items-center justify-between gap-2 cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <ItemIcon className="h-4 w-4" />
              {t(labelAr, labelEn)}
            </span>
            {theme === value && <Check className="h-4 w-4 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Simple toggle button variant (no dropdown)
export function ThemeToggleSimple() {
  const { toggleTheme, theme } = useTheme();
  const { t } = useLanguage();

  const currentTheme = themes.find((t) => t.value === theme) || themes[2];
  const Icon = currentTheme.icon;

  return (
    <Button
      variant="secondary"
      size="icon"
      onClick={toggleTheme}
      className="rounded-full w-10 h-10 bg-background/80 backdrop-blur-sm border border-border/50 hover:bg-primary/5 hover:border-primary/30 transition-all duration-300 shadow-sm"
      aria-label={`${t('المظهر الحالي:', 'Current theme:')} ${t(currentTheme.labelAr, currentTheme.labelEn)}`}
    >
      <Icon className="h-4 w-4 text-foreground/70" />
    </Button>
  );
}
