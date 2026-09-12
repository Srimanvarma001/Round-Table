import type { Metadata } from 'next';
import { Fraunces, Inter } from 'next/font/google';

import { AppShell } from '@/components/shell/AppShell';
import { Providers } from '@/components/shell/Providers';

import './globals.css';

// Section 16.9: two faces, both loaded with next/font so there is no layout
// shift. Inter is the UI and body face in both themes; the hearth theme swaps
// in a serif for display only, which is its strongest single signal.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const displaySerif = Fraunces({
  subsets: ['latin'],
  variable: '--font-display-serif',
  display: 'swap',
  axes: ['SOFT', 'WONK'],
});

export const metadata: Metadata = {
  title: 'Round Table',
  description: 'Weighted multi-agent idea generator',
};

/**
 * The theme attribute is read from the `settings` table on the server and
 * rendered into `data-theme` here, so the first paint is already in the right
 * theme and there is no flash. The client `useTheme` hook keeps it in sync
 * after a switch. Section 16.8.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="warroom" suppressHydrationWarning>
      <body className={`${inter.variable} ${displaySerif.variable} antialiased`}>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
