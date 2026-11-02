import { withSentryConfig } from '@sentry/nextjs';
import withSerwistInit from '@serwist/next';
import createMDX from '@next/mdx';
import type { NextConfig } from 'next';
import { buildContentSecurityPolicy } from './lib/security/csp';

const withMDX = createMDX({
  extension: /\.mdx?$/,
});

const withSerwist = withSerwistInit({
  // Ścieżka do service worker (pełna implementacja: zadanie 17.3)
  swSrc: 'app/sw.ts',
  swDest: 'public/sw.js',
  cacheOnNavigation: false,
  // W dev SW jest wyłączony (nie blokuje hot reload)
  disable: process.env.NODE_ENV === 'development',
  // Dynamiczny re-rejestr SW po powrocie online
  reloadOnOnline: true,
});

// Enforced policy; the self-hosted backend must be configured at build time.
const CSP_DIRECTIVES = buildContentSecurityPolicy({
  production: process.env.NODE_ENV === 'production',
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
});

const SECURITY_HEADERS: { key: string; value: string }[] = [
  // Audyt #7 / #29: Referrer-Policy globalny — potwierdzamy intencję z layoutu
  // /accountant (no-referrer) na poziomie całej domeny. Mniej powierzchni do
  // wycieku tokenów / paths przez Referer.
  { key: 'Referrer-Policy', value: 'no-referrer' },
  // Wymusza, że MIME nie jest "wnioskowany" przez przeglądarkę (np. text/html
  // w odpowiedzi na uploaded image → XSS).
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Legacy odpowiednik frame-ancestors 'none'. Trzymamy oba, bo niektóre
  // przeglądarki w przedsiębiorstwach wciąż preferują X-Frame-Options.
  { key: 'X-Frame-Options', value: 'DENY' },
  // Wyłączamy wszystkie powerful features, których nie używamy. Włączymy
  // selektywnie, gdy pojawi się skaner QR / kamera do KSeF QR.
  {
    key: 'Permissions-Policy',
    value:
      'camera=(), microphone=(), geolocation=(), browsing-topics=(), interest-cohort=()',
  },
  // Egzekwowanie polityki; inline bootstrap Next pozostaje do osobnego wdrożenia nonce.
  { key: 'Content-Security-Policy', value: CSP_DIRECTIVES },
];

const PROD_ONLY_HEADERS: { key: string; value: string }[] = [
  // HSTS tylko na prod — w lokalnym dev na `http://localhost:3000` ustawienie
  // tego nagłówka prowadzi do trwałego cache'a HSTS w przeglądarce i
  // niemożliwości wejścia na cokolwiek po http przez 1 rok.
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  pageExtensions: ['ts', 'tsx', 'js', 'jsx', 'md', 'mdx'],

  // Praca w git worktree: dwa `pnpm-workspace.yaml` — bez tego Next zgaduje root.
  outputFileTracingRoot: import.meta.dirname,

  // Migracja Hetzner (M5): build do obrazu Docker wymaga `standalone`
  // (samowystarczalny server.js + traced node_modules). Włączane JAWNIE
  // przez env w Dockerfile — build na Vercelu zostaje bez zmian.
  ...(process.env.NEXT_OUTPUT === 'standalone'
    ? { output: 'standalone' as const }
    : {}),

  // Pliki czytane z dysku w RUNTIME (fs.readFileSync + process.cwd()), których
  // statyczny tracing nie widzi: schematy XSD FA(3) (walidacja przed wysyłką
  // do KSeF), fonty PDF (pdfkit) i artykuły MDX centrum pomocy. Bez tego
  // standalone w Dockerze padnie na ENOENT przy pierwszej fakturze.
  outputFileTracingIncludes: {
    '/**': [
      './lib/xml/schemas/**',
      // XSD JPK: portal księgowej waliduje plik przed wydaniem (AUD-121).
      './lib/exports/schemas/**',
      './lib/pdf/fonts/**',
      './content/help/**',
    ],
  },

  experimental: {
    // Build na app-1 (20.10.2026): po ekranach Finory `next build --webpack`
    // przekroczył pułap sterty 3072 MB (exit 134). Mniejsze zużycie pamięci
    // webpacka kosztem kilku sekund builda; razem z pułapem 3584 MB
    // w Dockerfile (tests/unit/build-pamiec-sterty.test.ts).
    webpackMemoryOptimizations: true,
    // Plan Finora: prymitywy Base UI, ikony Remix, wykresy recharts (E1), paleta ⌘K cmdk (E2).
    optimizePackageImports: ['lucide-react', '@base-ui/react', '@remixicon/react', 'recharts', 'cmdk'],
  },

  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
        pathname: '/**',
      },
    ],
  },

  // `xmllint-wasm` ładuje plik `xmllint.wasm` z fizycznego node_modules przez
  // `fs.readFileSync` + `import.meta.url`. Gdy Turbopack bundluje kod serwerowy,
  // tłumaczy ścieżki modułów na wirtualne `/ROOT/...`, przez co WASM nie da się
  // znaleźć w runtime i walidacja FA(3) XSD pada na `ENOENT xmllint.wasm`.
  //
  // `serverExternalPackages` wyłącza pakiet z bundle'a po stronie serwera -
  // Next robi zwykły `require('xmllint-wasm')` z node_modules z poprawnymi
  // ścieżkami na dysku. To samo podejście co dla `sharp`, `canvas` i innych
  // pakietów z natywnymi/WASM assetami.
  serverExternalPackages: ['xmllint-wasm'],

  async headers() {
    const isProd = process.env.NODE_ENV === 'production';
    return [
      {
        source: '/:path*',
        headers: [
          ...SECURITY_HEADERS,
          ...(isProd ? PROD_ONLY_HEADERS : []),
        ],
      },
    ];
  },

  // Redesign: `/vs/fakturownia` → `/vs/inni` (SEO 308).
  // Zmiana marki: artykuły pomocy z nazwą w slugu (stare linki z maili i zakładek).
  async redirects() {
    return [
      {
        source: '/vs/fakturownia',
        destination: '/vs/inni',
        permanent: true,
      },
      {
        source: '/pomoc/pierwsze-kroki-w-faktflow',
        destination: '/pomoc/pierwsze-kroki-w-faktway',
        permanent: true,
      },
      {
        source: '/pomoc/platnosci-i-faktury-za-faktflow',
        destination: '/pomoc/platnosci-i-faktury-za-faktway',
        permanent: true,
      },
      // Decyzja Bartosza 22.10.2026: Magiczny import znika — historię z KSeF
      // FaktWay pobiera sam, a postęp i import plików są w Imporcie danych.
      // Stare linki (zakładki, maile) nie kończą się 404.
      {
        source: '/onboarding/magic-import',
        destination: '/import-danych',
        permanent: true,
      },
    ];
  },

  // PostHog reverse proxy (Faza 31) — ruch analityczny leci przez naszą
  // domenę pod `/ingest`, omijając ad-blockery blokujące `*.posthog.com`.
  // Region EU (zgodność z hostingiem Supabase / R2).
  // Next przekazuje celowi nagłówki żądania — ciasteczka zdejmuje proxy
  // (`lib/telemetry-tunnel.ts`); nowe ścieżki tunelu dopisz też tam.
  async rewrites() {
    return [
      {
        source: '/ingest/static/:path*',
        destination: 'https://eu-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/ingest/array/:path*',
        destination: 'https://eu-assets.i.posthog.com/array/:path*',
      },
      {
        source: '/ingest/:path*',
        destination: 'https://eu.i.posthog.com/:path*',
      },
    ];
  },
  // PostHog wysyła część żądań metodą innej niż domyślne — bez tego
  // `/ingest/decide` pada na trailing-slash redirect.
  skipTrailingSlashRedirect: true,
};

export default withSentryConfig(withSerwist(withMDX(nextConfig)), {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: process.env.SENTRY_ORG ?? 'faktflow',

  project: process.env.SENTRY_PROJECT ?? 'javascript-nextjs',

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Bez rozszerzonego zestawu map źródłowych: z @sentry/nextjs 10.75.2 (łatka
  // GHSA-mchm-gjx6-7h55 dla `tunnelRoute`) build rośnie ponad 3584 MB sterty;
  // pułap podniesiony do 4096 MB (Dockerfile), a to oszczędza zapas na app-1.
  // Mapy stron i chunków dalej idą.
  widenClientFileUpload: false,

  bundleSizeOptimizations: {
    excludeReplayShadowDom: true,
    excludeReplayIframe: true,
    excludeReplayWorker: true,
    excludeDebugStatements: true,
  },

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Proxy (`proxy.ts`) obejmuje tunel i przepuszcza go bez sesji i bez ciasteczek
  // (`lib/telemetry-tunnel.ts`). Wrapper Sentry, który omijał proxy na tej
  // ścieżce, przy `output: standalone` i Next ≥ 16 jest wyłączony — nie licz na niego.
  tunnelRoute: '/monitoring',

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    // Vercela nie ma od 14.09.2026 (Hetzner) — instrumentacja cronów Vercela tylko obciąża build.
    automaticVercelMonitors: false,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
