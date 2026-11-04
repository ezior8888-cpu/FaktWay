import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OFERTA, OFERTA_NAGLOWEK } from '@/lib/marketing/oferta';
import {
  formatPln,
  MONTHLY_NET_PLN,
  MONTHLY_PRICE_GROSS_GROSZE,
  MONTHLY_PRICE_NET_GROSZE,
  MONTHLY_VAT_GROSZE,
  PRICE_GROSS,
  PRICE_NET,
  PRICE_PER_MONTH_WITH_NET,
  PRICE_VAT,
  TRIAL_DAYS,
} from '@/lib/billing/pricing';

/**
 * Krok 8 planu automatyzacji (AUD-28, AUD-73): w repo było pięć wersji
 * cennika i trzy definicje triala. Od 1 października 2026 cena żyje tylko
 * w lib/billing/pricing.ts, a ten test pilnuje, żeby stare kwoty nie wróciły
 * do treści, maili ani panelu.
 */

const ROOT = join(__dirname, '..', '..');
const SCANNED = ['app', 'components', 'lib', 'content'];
const EXTENSIONS = /\.(tsx?|mdx?)$/;

// Stare ceny i obietnice, których nie wolno pokazywać klientom.
const FORBIDDEN: Array<[RegExp, string]> = [
  [/(?<![\d,])(?:39,99|49|59|588|708)\s?(?:zł|PLN)\b/, 'stara cena'],
  [/money-back/i, 'gwarancja zwrotu (usunięta 1.10.2026)'],
  [/60 dni gwarancji/i, 'gwarancja zwrotu (usunięta 1.10.2026)'],
  [/\+ ?VAT 23%/, 'cena „+ VAT” zamiast brutto'],
  // Decyzja FaktWay 1.0: cena tylko z lib/billing/pricing.ts. Plik MDX nie umie
  // jej zaimportować, więc pisze „abonament” i linkuje do cennika.
  [/29,99|24,38|5,61 zł/, 'cena wpisana na sztywno'],
];

// Pliki, które OPISUJĄ historię cennika (komentarze), a nie pokazują ceny.
const ALLOWED = new Set(['lib/billing/pricing.ts', 'lib/flo/budget.ts']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return EXTENSIONS.test(name) ? [path] : [];
  });
}

describe('cena FaktWay', () => {
  it('29,99 zł brutto = 24,38 zł netto + 5,61 zł VAT', () => {
    expect(MONTHLY_PRICE_GROSS_GROSZE).toBe(2999);
    expect(MONTHLY_PRICE_NET_GROSZE).toBe(2438);
    expect(MONTHLY_VAT_GROSZE).toBe(561);
    expect(MONTHLY_PRICE_NET_GROSZE + MONTHLY_VAT_GROSZE).toBe(MONTHLY_PRICE_GROSS_GROSZE);
    expect([PRICE_GROSS, PRICE_NET, PRICE_VAT]).toEqual(['29,99 zł', '24,38 zł', '5,61 zł']);
    expect(PRICE_PER_MONTH_WITH_NET).toBe('29,99 zł/mc z VAT (24,38 zł netto)');
    expect(MONTHLY_NET_PLN).toBe(24.38);
  });

  it('zdanie oferty bierze cenę z PRICE_GROSS', () => {
    expect(OFERTA).toContain(`za ${PRICE_GROSS} miesięcznie`);
    expect(OFERTA_NAGLOWEK.po.replaceAll('\u00a0', ' ')).toContain(PRICE_GROSS);
  });

  it('format kwot', () => {
    expect(formatPln(5)).toBe('0,05 zł');
    expect(formatPln(100)).toBe('1,00 zł');
    expect(formatPln(12345)).toBe('123,45 zł');
  });

  it('trial: 30 dni', () => {
    expect(TRIAL_DAYS).toBe(30);
  });

  it('żadnych starych cen ani gwarancji zwrotu w treściach, mailach i panelu', () => {
    const hits: string[] = [];
    for (const dir of SCANNED) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file).replaceAll('\\', '/');
        if (ALLOWED.has(rel)) continue;
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          for (const [pattern, why] of FORBIDDEN) {
            if (pattern.test(line)) hits.push(`${rel}:${i + 1} — ${why}`);
          }
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
