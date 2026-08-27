import type { Metadata } from 'next';
import '../app/globals.css';
import { LOCALE } from '../constants';
import { labels } from '../labels';

export const metadata: Metadata = {
  title: labels.appName,
  description: 'TrustMe operator console',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang={LOCALE.lang} dir={LOCALE.dir}>
      <body>{children}</body>
    </html>
  );
}
