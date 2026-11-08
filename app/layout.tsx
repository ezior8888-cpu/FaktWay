import type { Metadata, Viewport } from 'next';
import {
  Geist,
  IBM_Plex_Mono,
  Outfit,
} from 'next/font/google';

// Ikony panelu z własnego serwera (pakiet `material-symbols`, Apache-2.0).
// Do 15.10.2026 arkusz i czcionka szły z fonts.googleapis.com / fonts.gstatic.com
// na KAŻDEJ stronie — adres IP odwiedzającego trafiał do Google bez zgody
// (LG München I, 3 O 17493/20: 100 € zadośćuczynienia, potem fala wezwań).
// `next/font/google` pobiera czcionki przy budowaniu, ale ikon Material Symbols
// nie obsługuje — stąd pakiet. Pilnuje: tests/unit/bez-czcionek-google.test.ts.
import 'material-symbols/outlined.css';
import './globals.css';
import { AnalyticsProvider } from '@/components/analytics/analytics-provider';
import { SentryClientInit } from '@/components/sentry-client-init';
import { Toaster } from '@/components/ui/sonner';
import { OFERTA } from '@/lib/marketing/oferta';
import { THEME_BOOT_SCRIPT } from '@/lib/theme/theme';
import { siteUrl } from '@/lib/site';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

// Fraunces (marketing) jest w `app/(marketing)/_fonts.ts`, nie tutaj:
// font z root layoutu `next/font` preładowuje na KAŻDEJ trasie, także
// w panelu, który go nie używa.

// Typografia aplikacji (plan Finora, D2): Outfit na interfejs, IBM Plex Mono
// na liczby, NIP-y, numery faktur i daty — dzięki stałej szerokości znaku
// kwoty w kolumnach tabel wyrównują się do przecinka. `latin-ext` jest
// KRYTYCZNE dla polskich znaków (ą, ć, ę, ł, ń, ó, ś, ź, ż). Outfit jest
// fontem zmiennym, więc bez listy wag. Strona główna, strony marketingowe
// i logowanie stoją od 23.10.2026 na tym samym foncie co panel (wcześniej
// landing i marketing miały Geist z arkusza szablonu Zova).
const outfit = Outfit({
  variable: '--font-outfit',
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: '--font-ibm-plex-mono',
  weight: ['400', '500', '600'],
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: 'FaktWay',
  description: OFERTA,
  // PWA / iOS (Safari) — manifest z `app/manifest.ts` nie wystarczy na iOS
  applicationName: 'FaktWay',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'FaktWay',
  },
  formatDetection: {
    telephone: false,
  },
  // Pliki z docs/brand/logo/zrodla/aplikacja.py. `icon.svg` w trybie ciemnym
  // przełącza się na jasny niebieski; `favicon.ico` (16/32/48 px) dla reszty.
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/icons/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  /**
   * Te same kolory co `--background` presetu Finora w `app/globals.css`
   * (jasny oklch(1 0 0), ciemny oklch(0.20 0 0)) i co `theme_color`
   * w `app/manifest.ts`. Do września 2026 były trzy różne zestawy w trzech
   * plikach, więc pasek stanu telefonu miał inny odcień niż tło strony.
   */
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#161616' },
  ],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  colorScheme: 'dark light',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pl"
      suppressHydrationWarning
      data-scroll-behavior="smooth"
      className={`${geistSans.variable} ${outfit.variable} ${ibmPlexMono.variable} h-full scroll-smooth antialiased`}
    >
      <head>
        {/* Klasa `dark` NIE jest już zaszyta na <html> (było tak do 29.08.2026).
            Motyw domyślny to jasny; ten skrypt dokłada `dark` przed pierwszym
            malowaniem, gdy klient wybrał ciemny. Kolejność ma znaczenie:
            skrypt musi być pierwszym elementem <head>. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-screen font-sans antialiased text-foreground">
        <SentryClientInit />
        <AnalyticsProvider>{children}</AnalyticsProvider>
        {/* Wygląd toastów: tokeny `--popover*` z `components/ui/sonner.tsx`
            (plan Finora, E1). Dawne klasy „szkła” usunięte — sonner wstrzykuje
            własny CSS poza warstwami Tailwinda, więc i tak prawie nie działały. */}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
