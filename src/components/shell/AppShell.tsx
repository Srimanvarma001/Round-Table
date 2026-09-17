'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { useSettings } from '@/hooks/useSettings';
import { CityBackground } from '@/components/shell/CityBackground';

const NAV = [
  { href: '/run', label: 'Table' },
  { href: '/runs', label: 'History' },
  { href: '/agents', label: 'Seats' },
  { href: '/profile', label: 'Profile' },
  { href: '/settings', label: 'Settings' },
] as const;

/**
 * Chrome around every page. The theme is applied to <html data-theme> so both
 * theme token sets swap with a single attribute.
 *
 * Fixed-height control room: root is exactly 100dvh with overflow hidden, the
 * header takes its natural 56px, and main fills the rest with no page scroll.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { theme } = useSettings();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div className="backroom themed-grid relative flex h-[100dvh] flex-col overflow-hidden">
      <CityBackground />
      <header className="relative z-40 h-14 shrink-0 border-b border-[var(--line)] bg-[var(--bg-elev-1)]/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-5 px-4">
          <Link href="/run" className="display-face flex items-center gap-2 text-[var(--text)]">
            {/* Eight chips around a ring: the product mark, echoing the table. */}
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="7" fill="none" stroke="var(--line-strong)" strokeWidth="1.5" />
              {Array.from({ length: 8 }, (_, i) => {
                const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
                return (
                  <circle
                    key={i}
                    cx={10 + 7 * Math.cos(a)}
                    cy={10 + 7 * Math.sin(a)}
                    r="1.7"
                    fill={`var(--seat-${i + 1})`}
                  />
                );
              })}
            </svg>
            <span className="text-[16px] font-semibold tracking-tight">Round Table</span>
          </Link>

          <nav className="flex items-center gap-0.5" aria-label="Main">
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'rounded-lg px-2.5 py-1.5 text-[13px] transition-colors',
                    active
                      ? 'bg-[var(--gold)]/15 text-[var(--gold-hi)]'
                      : 'text-[var(--text-dim)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]',
                  ].join(' ')}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <p className="display-face ml-auto hidden text-[13px] italic text-[var(--text-mute)] lg:block">
            The backroom is in session
          </p>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col overflow-hidden px-4 py-2">
        {children}
      </main>
    </div>
  );
}
