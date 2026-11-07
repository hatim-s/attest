import { useState } from 'react';
import { browserStorage, readTheme, writeTheme, type ThemeMode } from './preferences.js';

/** CSS follows OS changes in system mode without a network or matchMedia listener. */
const useTheme = () => {
  const [theme, setTheme] = useState<ThemeMode>(() => readTheme(browserStorage()));

  const cycleTheme = () => {
    const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    writeTheme(browserStorage(), next);
    setTheme(next);
  };

  return { theme, cycleTheme };
};

export { useTheme };
