import type { Metadata } from 'next';

import { Shell } from '@/components/Shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'Verity — supervisory prototype',
  description:
    'Making loan classification tamper-evident. BCOLBD 2026 prototype, Team Logarithm. Synthetic data throughout.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
