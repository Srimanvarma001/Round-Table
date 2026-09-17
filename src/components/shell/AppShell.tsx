'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { CityBackground } from '@/components/shell/CityBackground';
import { SideNav } from '@/components/shell/SideNav';
import { useSettings } from '@/hooks/useSettings';

/**
 * Chrome around every page. The theme is applied to <html data-theme> so both
 * theme token sets swap with a single attribute.
 *
 * No top bar: the root is exactly 100dvh with overflow hidden, and all
 * navigation lives in a slim vertical rail docked to the right edge. The
 * Table page carries its own right-hand controls panel and mounts the nav as
 * that panel's top section (SideNav variant="panel"), so the global rail is
 * skipped there rather than stack a second sidebar; every other page gets
 * the rail. Content pages scroll in the main column; the Table page stays a
 * fixed single-viewport control room.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { theme } = useSettings();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const isTablePage = pathname === '/run';

  return (
    <div className="backroom themed-grid relative flex h-[100dvh] overflow-hidden">
      <CityBackground />
      <main
        className={[
          'relative z-10 mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col px-4',
          isTablePage ? 'overflow-hidden py-2' : 'overflow-y-auto py-6',
        ].join(' ')}
      >
        {children}
      </main>
      {!isTablePage ? <SideNav /> : null}
    </div>
  );
}
