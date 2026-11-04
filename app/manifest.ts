// app/manifest.ts
// Next.js generuje /manifest.webmanifest z tego pliku
import type { MetadataRoute } from 'next';

import { OFERTA } from '@/lib/marketing/oferta';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'FaktWay: faktury',
    short_name: 'FaktWay',
    description: OFERTA,
    /**
     * `/dashboard`, nie `/invoices`. `APP_HOME` w `lib/supabase/middleware.ts`
     * wskazuje dashboard, a od 30.08.2026 to właśnie on JEST ekranem agenta.
     * Skrót w manifeście prowadził gdzie indziej niż logowanie, więc aplikacja
     * dodana do ekranu głównego otwierała się w innym miejscu niż ta sama
     * aplikacja otwarta z przeglądarki.
     */
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    /**
     * Kolory z ery ciemnego motywu (`#0a0a0b` / `#000000`) — motyw domyślny
     * jest jasny od 30.08.2026. Na telefonie widać to wprost: przy dodaniu do
     * ekranu głównego ekran startowy błyskał czernią, a pasek stanu w trybie
     * `standalone` zostawał czarny nad białym interfejsem.
     * Wartości zgodne z `--background` presetu Finora (jasny) z
     * `app/globals.css`; manifest nie ma wariantu ciemnego.
     */
    background_color: '#ffffff',
    theme_color: '#ffffff',
    lang: 'pl-PL',
    categories: ['business', 'finance', 'productivity'],
    /**
     * Ikony z docs/brand/logo/zrodla/aplikacja.py. „any”: znak na kaflu
     * z zaokrągleniem. „maskable”: pełne niebieskie tło, znak w strefie
     * bezpiecznej (Android sam przycina kształt). Do 25.10.2026 manifest
     * wskazywał pliki, których w `public/icons/` nie było (404).
     */
    icons: [
      { src: '/icons/icon-72x72.png', sizes: '72x72', type: 'image/png' },
      { src: '/icons/icon-96x96.png', sizes: '96x96', type: 'image/png' },
      { src: '/icons/icon-128x128.png', sizes: '128x128', type: 'image/png' },
      { src: '/icons/icon-144x144.png', sizes: '144x144', type: 'image/png' },
      { src: '/icons/icon-152x152.png', sizes: '152x152', type: 'image/png' },
      {
        src: '/icons/icon-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/maskable-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      { src: '/icons/icon-384x384.png', sizes: '384x384', type: 'image/png' },
      {
        src: '/icons/icon-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/maskable-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      {
        name: 'Wystaw fakturę',
        short_name: 'Nowa',
        description: 'Wystaw fakturę i wyślij do KSeF',
        url: '/invoices/new',
        icons: [{ src: '/icons/icon-96x96.png', sizes: '96x96' }],
      },
      {
        name: 'Skrzynka KSeF',
        short_name: 'KSeF',
        description: 'Faktury otrzymane przez KSeF',
        url: '/inbox',
        icons: [{ src: '/icons/icon-96x96.png', sizes: '96x96' }],
      },
    ],
    share_target: {
      action: '/share-target',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        title: 'title',
        text: 'text',
        url: 'url',
        files: [
          {
            name: 'photo',
            accept: [
              'image/jpeg',
              'image/png',
              'image/webp',
              'application/pdf',
            ],
          },
        ],
      },
    },
  };
}
