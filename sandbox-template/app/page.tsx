'use client';

import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LanguageToggle } from '@/components/LanguageToggle';
import { useLanguage } from '@/contexts/LanguageContext';
import { ArrowRight, ArrowLeft } from 'lucide-react';

export default function Home() {
  const { t, isArabic } = useLanguage();
  const Arrow = isArabic ? ArrowLeft : ArrowRight;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="fixed top-6 end-6 z-50 flex items-center gap-2">
        <LanguageToggle />
        <ThemeToggle />
      </div>

      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center space-y-6 max-w-2xl">
          <h1 className="text-5xl sm:text-6xl md:text-7xl font-bold leading-relaxed">
            {t('ابنِ شيئًا', 'Build Something')}
            <span className="block text-primary">{t('مذهلًا', 'Amazing')}</span>
          </h1>

          <p className="text-lg text-muted-foreground max-w-md mx-auto">
            {t(
              'قالب Next.js بسيط للبدء بسرعة.',
              'A minimal Next.js template to get you started quickly.'
            )}
          </p>

          <a href="https://etlaq.sa" target="_blank" rel="noopener noreferrer">
            <Button size="lg" variant="default" className="rounded-full px-8">
              {t('ابدأ الآن', 'Get Started')}
              <Arrow className="ms-2 h-4 w-4" />
            </Button>
          </a>
        </div>
      </main>

      <footer className="absolute bottom-0 w-full py-6 text-center text-sm text-muted-foreground">
        {t('إطلاق ستوديو', 'Etlaq Studio')}
      </footer>
    </div>
  );
}
