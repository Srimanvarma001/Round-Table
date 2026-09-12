'use client';

import { useCallback } from 'react';

import { DEFAULT_THEME, THEMES, type ThemeName } from '@/shared/constants';
import { useSettings, useUpdateSettings } from './useSettings';

/**
 * Theme token switch, section 16.8.
 *
 * Both themes are first-class token sets behind one `data-theme` attribute.
 * The choice persists in the `settings` table; `AppShell` applies it to
 * `<html>` so the first paint after a switch recolours every seat with no
 * other change. This hook is the single place a component reads or writes the
 * active theme.
 */
export function useTheme() {
  const { settings, isLoading } = useSettings();
  const update = useUpdateSettings();

  const theme = (settings.theme ?? DEFAULT_THEME) as ThemeName;

  const setTheme = useCallback(
    (next: ThemeName) => update.mutate({ theme: next }),
    [update],
  );

  const cycleTheme = useCallback(() => {
    const idx = THEMES.indexOf(theme);
    setTheme(THEMES[(idx + 1) % THEMES.length]);
  }, [theme, setTheme]);

  return {
    theme,
    themes: THEMES,
    isLoading,
    isSaving: update.isPending,
    saveError: update.error instanceof Error ? update.error.message : null,
    setTheme,
    cycleTheme,
  };
}
