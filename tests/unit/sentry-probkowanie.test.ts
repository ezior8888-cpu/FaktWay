import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_TRACES_RATE, tracesSampler } from '@/lib/observability/sentry-sampling';

/**
 * Plan skalowania, sesja 23 (EXT-15): śledzenie Sentry pomija healthchecki,
 * telemetrię i prefetch. Stała próbka 10% bez filtra zjadała limit planu na
 * żądaniach, które nic nie mówią o wydajności (baner KSeF co 30 s z każdej karty).
 */

const ROOT = join(__dirname, '..', '..');

describe('próbkowanie śledzenia Sentry (sesja 23)', () => {
  it.each([
    '/api/health',
    '/api/live',
    '/api/status/components',
    '/api/ksef/health',
    '/ingest/e/',
    '/monitoring',
    '/_next/static/chunks/main.js',
    '/sw.js',
    '/manifest.webmanifest',
    '/robots.txt',
    '/sitemap.xml',
    '/favicon.ico',
  ])('%s: 0', (path) => {
    expect(tracesSampler({ name: `GET ${path}` })).toBe(0);
  });

  it('ścieżkę bierze też z atrybutów, adresu żądania i lokalizacji przeglądarki', () => {
    expect(tracesSampler({ name: 'GET', attributes: { 'url.path': '/api/health' } })).toBe(0);
    expect(tracesSampler({ name: 'GET', attributes: { 'http.target': '/api/ksef/health?t=1' } })).toBe(0);
    expect(tracesSampler({ name: 'GET', normalizedRequest: { url: 'https://faktflow.pl/api/health?x=1' } })).toBe(0);
    expect(tracesSampler({ name: 'pageload', location: { pathname: '/dashboard' } })).toBe(DEFAULT_TRACES_RATE);
  });

  it('prefetch Next.js: 0', () => {
    expect(
      tracesSampler({ name: 'GET /invoices', normalizedRequest: { url: '/invoices', headers: { 'next-router-prefetch': '1' } } }),
    ).toBe(0);
  });

  it('zwykłe trasy: stała próbka jak dotąd', () => {
    expect(tracesSampler({ name: 'GET /dashboard' })).toBe(DEFAULT_TRACES_RATE);
    expect(tracesSampler({ name: 'POST /invoices/new' })).toBe(DEFAULT_TRACES_RATE);
    // Podobny prefiks nie jest pomijany.
    expect(tracesSampler({ name: 'GET /api/healthcheck-raport' })).toBe(DEFAULT_TRACES_RATE);
    expect(DEFAULT_TRACES_RATE).toBe(0.1);
  });

  it('decyzja rodzica wygrywa (inheritOrSampleWith)', () => {
    const calls: number[] = [];
    const rate = tracesSampler({
      name: 'GET /dashboard',
      parentSampled: true,
      inheritOrSampleWith: (fallback) => {
        calls.push(fallback);
        return 1;
      },
    });
    expect(rate).toBe(1);
    expect(calls).toEqual([DEFAULT_TRACES_RATE]);
  });

  it('wszystkie trzy konfiguracje Sentry używają tracesSampler zamiast stałej próbki', () => {
    for (const file of ['sentry.server.config.ts', 'sentry.edge.config.ts', 'instrumentation-client.ts']) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      // Bez komentarzy (komentarz z nazwą starej opcji nie jest jej użyciem).
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).toContain('Sentry.init(');
      expect(code, file).toContain('tracesSampler');
      expect(code, file).not.toContain('tracesSampleRate');
    }
  });
});
