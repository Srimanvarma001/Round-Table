'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { DEFAULT_THEME, type ThemeName } from '@/shared/constants';
import type { SettingsDTO, SettingsResponse } from '@/shared/types';

/**
 * Non-secret runtime settings, section 6.2. The theme lives here so the shell
 * and the settings page share one source of truth.
 */

export const FALLBACK_SETTINGS: SettingsDTO = {
  theme: DEFAULT_THEME,
  budgetUsd: 1.0,
  maxTokens: 250_000,
  maxCalls: 60,
  staggerCadenceMs: 45,
  refineEnabled: true,
  maxCritiquesPerAgent: 3,
  reasoningPanelEnabled: true,
  defaultAvatarStyle: 'dicebear',
  temperatureBySeatClass: { me: 0.7, lens: 0.7 },
  requestTimeoutMs: 90_000,
  retries: 2,
  concurrency: 8,
};

async function fetchSettings(): Promise<SettingsResponse> {
  const res = await fetch('/api/settings', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load settings (${res.status})`);
  return (await res.json()) as SettingsResponse;
}

export function useSettings() {
  const query = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    staleTime: 60_000,
  });

  return {
    ...query,
    settings: query.data?.settings ?? FALLBACK_SETTINGS,
    providers: query.data?.providers ?? null,
    pricing: query.data?.pricing ?? [],
    pricingUpdatedAt: query.data?.pricingUpdatedAt ?? null,
    theme: (query.data?.settings.theme ?? DEFAULT_THEME) as ThemeName,
  };
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<SettingsDTO>) => {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Failed to save settings (${res.status})`);
      }
      return (await res.json()) as SettingsResponse;
    },
    onSuccess: (data) => {
      qc.setQueryData(['settings'], data);
    },
  });
}
