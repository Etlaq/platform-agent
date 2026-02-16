'use client';

import { createContext, useContext, useEffect, useCallback, useSyncExternalStore } from 'react';

type Language = 'ar' | 'en';
type Direction = 'rtl' | 'ltr';

interface LanguageContextType {
  lang: Language;
  dir: Direction;
  isArabic: boolean;
  setLanguage: (lang: Language) => void;
  t: (ar: string, en: string) => string;
}

const LanguageContext = createContext<LanguageContextType | null>(null);

function getStoredLang(): Language {
  if (typeof window === 'undefined') return 'ar';
  const saved = localStorage.getItem('lang');
  return saved === 'en' ? 'en' : 'ar';
}

let listeners: (() => void)[] = [];

function subscribe(listener: () => void) {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter(l => l !== listener);
  };
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const lang = useSyncExternalStore(subscribe, getStoredLang, () => 'ar' as Language);

  useEffect(() => {
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang === 'ar' ? 'ar-SA' : 'en';
    document.documentElement.dir = dir;
  }, [lang]);

  const setLanguage = useCallback((newLang: Language) => {
    localStorage.setItem('lang', newLang);
    listeners.forEach(listener => listener());
  }, []);

  const t = useCallback((ar: string, en: string) => {
    return lang === 'ar' ? ar : en;
  }, [lang]);

  return (
    <LanguageContext.Provider
      value={{
        lang,
        dir: lang === 'ar' ? 'rtl' : 'ltr',
        isArabic: lang === 'ar',
        setLanguage,
        t,
      }}
    >
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within LanguageProvider');
  }
  return context;
}
