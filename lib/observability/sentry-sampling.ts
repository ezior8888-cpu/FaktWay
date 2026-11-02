/**
 * Próbkowanie śledzenia Sentry (plan skalowania, sesja 23, EXT-15).
 *
 * Stała próbka 10% bez filtra liczyła też healthchecki, telemetrię
 * (`/ingest`, tunel `/monitoring`), statyczne pliki i prefetch — żądania,
 * które nic nie mówią o wydajności, a zjadają limit planu (baner KSeF odpytuje
 * `/api/ksef/health` z każdej otwartej karty). Te dostają 0, reszta jak dotąd.
 *
 * Wspólny dla Node, Edge i przeglądarki: bez importów `node:` i bez
 * `@sentry/core` (typ wejścia lokalny — tylko pola, które czytamy).
 */

export const DEFAULT_TRACES_RATE = 0.1;

/** Podzbiór `TracesSamplerSamplingContext` z `@sentry/core`. */
export type TracesSamplingContext = {
  name?: string;
  parentSampled?: boolean;
  attributes?: Record<string, unknown>;
  normalizedRequest?: { url?: string; headers?: Record<string, string | string[] | undefined> };
  location?: { pathname?: string };
  inheritOrSampleWith?: (fallbackSampleRate: number) => number;
};

/** Ścieżka albo cała, albo z podścieżkami (`/api/status` → `/api/status/x`). */
const SKIPPED_PREFIXES = ['/api/health', '/api/live', '/api/status', '/api/ksef/health', '/ingest', '/monitoring', '/_next'];
const SKIPPED_FILES = new Set(['/sw.js', '/manifest.webmanifest', '/robots.txt', '/sitemap.xml', '/favicon.ico']);
const PATH_ATTRIBUTES = ['url.path', 'http.target', 'http.route'] as const;
/** Nagłówki prefetchu routera Next.js (zwykły i segmentowy). */
const PREFETCH_HEADERS = ['next-router-prefetch', 'next-router-segment-prefetch'];

function pathOf(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  if (value.startsWith('/')) return value.split(/[?#]/, 1)[0];
  try {
    return new URL(value).pathname;
  } catch {
    return null;
  }
}

/** „GET /x” albo „/x” → „/x”; nazwa bez ścieżki („pageload”, „GET”) → null. */
function pathFromName(name: string | undefined): string | null {
  if (!name) return null;
  const path = name.startsWith('/') ? name : name.split(' ', 2)[1];
  return pathOf(path);
}

function candidatePaths(ctx: TracesSamplingContext): string[] {
  const paths = [
    pathFromName(ctx.name),
    ...PATH_ATTRIBUTES.map((key) => pathOf(ctx.attributes?.[key])),
    pathOf(ctx.normalizedRequest?.url),
    pathOf(ctx.location?.pathname),
  ];
  return paths.filter((path): path is string => path !== null);
}

function isSkippedPath(path: string): boolean {
  if (SKIPPED_FILES.has(path)) return true;
  return SKIPPED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function isPrefetch(ctx: TracesSamplingContext): boolean {
  const headers = ctx.normalizedRequest?.headers;
  if (!headers) return false;
  return Object.entries(headers).some(
    ([key, value]) => PREFETCH_HEADERS.includes(key.toLowerCase()) && value !== undefined && value !== '',
  );
}

export function tracesSampler(ctx: TracesSamplingContext): number {
  if (isPrefetch(ctx) || candidatePaths(ctx).some(isSkippedPath)) return 0;
  // Decyzja rodzica (przychodzący ślad) wygrywa nad stałą próbką.
  if (ctx.inheritOrSampleWith) return ctx.inheritOrSampleWith(DEFAULT_TRACES_RATE);
  if (typeof ctx.parentSampled === 'boolean') return ctx.parentSampled ? 1 : 0;
  return DEFAULT_TRACES_RATE;
}
