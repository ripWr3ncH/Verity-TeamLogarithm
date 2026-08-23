import type { Metadata } from 'next';
import { IBM_Plex_Mono, Plus_Jakarta_Sans } from 'next/font/google';

import { Shell } from '@/components/Shell';
import './globals.css';

/**
 * next/font downloads these at BUILD time and serves them from our own origin,
 * so the venue needs no internet. A demo that depends on fonts.googleapis.com
 * resolving is a demo that can fail in front of judges for no good reason.
 *
 * Plus Jakarta Sans matches the geometric grotesque in ui-references/ —
 * high x-height, tight letterforms, heavy weights that hold up on a projector.
 * IBM Plex Mono carries hashes, transaction ids and refusal codes.
 */
const sans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Verity — supervisory prototype',
  description:
    'Making loan classification tamper-evident. BCOLBD 2026 prototype, Team Logarithm. Synthetic data throughout.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
