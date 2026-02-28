import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FiberPeru – Panel de Pagos WhatsApp',
  description: 'Plataforma de automatización de pagos vía WhatsApp para ISP',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: 'any' },
    ],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning>
      <body className="bg-[#0a0f1e] text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
