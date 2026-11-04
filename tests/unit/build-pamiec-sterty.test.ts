import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Build produkcyjny na `app-1` (20.10.2026): `next build --webpack` padł
 * z „JavaScript heap out of memory” (exit 134) przy pułapie 3072 MB, po
 * scaleniu ekranów Finory (#293–#295). Pomiar lokalny szczytu sterty
 * kompilacji: wdrożony `67251ef6` 3296 MB, `main` 4365 MB, `main`
 * z `webpackMemoryOptimizations` 3526 MB, bez map źródeł 3114 MB (mapy
 * idą do Sentry, więc zostają). Pilnujemy obu ustawień, które razem
 * mieszczą build: optymalizacji pamięci webpacka i pułapu sterty.
 */
const root = join(__dirname, '..', '..');

describe('build produkcyjny mieści się w pamięci app-1', () => {
  it('next.config.ts włącza experimental.webpackMemoryOptimizations', () => {
    const config = readFileSync(join(root, 'next.config.ts'), 'utf8');
    expect(config).toMatch(/experimental:\s*\{[\s\S]*?webpackMemoryOptimizations:\s*true/);
  });

  // 22.10.2026: 4096 MB — łatki Next 16.4.1 i @sentry/nextjs 10.75.2 nie mieszczą się w 3584 MB.
  it('Dockerfile daje buildowi co najmniej 4096 MB sterty', () => {
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const cap = Number(dockerfile.match(/--max-old-space-size=(\d+)/)?.[1]);
    expect(cap).toBeGreaterThanOrEqual(4096);
  });
});
