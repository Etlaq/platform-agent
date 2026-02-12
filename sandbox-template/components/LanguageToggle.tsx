'use client';

import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';

export function LanguageToggle() {
  const { lang, setLanguage } = useLanguage();

  return (
    <Button
      size="icon"
      variant="secondary"
      onClick={() => setLanguage(lang === 'ar' ? 'en' : 'ar')}
      className="rounded-full w-10 h-10 bg-background/80 backdrop-blur-sm border border-border/50 hover:bg-primary/5 hover:border-primary/30 transition-all duration-300 shadow-sm font-medium"
      aria-label={lang === 'ar' ? 'Switch to English' : 'التبديل إلى العربية'}
    >
      {lang === 'ar' ? 'EN' : 'ع'}
    </Button>
  );
}
