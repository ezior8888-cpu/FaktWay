import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Proforma i oferta poza KSeF i poza przychodem (plan kompletnej aplikacji,
 * krok 2.4, ryzyko R2: dokument z kwotami, który nie jest fakturą). MF: „Do
 * KSeF nie przesyła się faktur proforma” (ksef.podatki.gov.pl, „Zakres
 * obowiązkowego KSeF”). Dokumenty leżą we własnych tabelach (00198), więc
 * KSeF, KPiR, ewidencja, JPK, raporty, pulpit, przypomnienia o płatności,
 * eksporty, archiwum, portal księgowej i publiczne API ich nie widzą, dopóki
 * żaden z tych modułów do nich nie sięgnie. Ten strażnik pilnuje obu stron:
 *  - moduły przychodu i KSeF nie znają tabel ani modułu proform;
 *  - moduł proform nie woła KSeF, generatorów XML, kolejki zadań ani ksiąg
 *    i nie zapisuje faktur (fakturę zapisuje wyłącznie formularz faktury po
 *    kliknięciu człowieka, z powiązaniem w tym samym INSERT).
 */

const ROOT = process.cwd();

/** Moduły, które liczą przychód, wysyłają do KSeF albo pokazują pieniądze firmy. */
const MODULY_PRZYCHODU = [
  'lib/ksef',
  'lib/xml',
  'lib/jobs',
  'lib/exports',
  'lib/ksiegowosc',
  'lib/categorization',
  'lib/reports',
  'lib/dashboard',
  'lib/analytics-finance',
  'lib/overdue',
  'lib/reminders',
  'lib/api',
  'lib/archiwum',
  'lib/accountant',
  'lib/invoice-share',
  'lib/kalendarz',
  'lib/webhooks',
  'app/api/v1',
  'app/(dashboard)/reports',
  'app/(dashboard)/przeplywy',
  'app/(dashboard)/analizy',
  'app/(dashboard)/dashboard',
];

/** Pliki modułu proform. */
const MODUL_PROFORM = ['lib/proformy', 'app/(dashboard)/proformy', 'app/api/proformy', 'app/actions/proformy.ts'];

function pliki(sciezka: string): string[] {
  const pelna = join(ROOT, sciezka);
  if (statSync(pelna).isFile()) return [sciezka];
  return readdirSync(pelna).flatMap((nazwa) => {
    const rel = `${sciezka}/${nazwa}`;
    if (statSync(join(ROOT, rel)).isDirectory()) return pliki(rel);
    return /\.(ts|tsx|mjs)$/.test(nazwa) && !/\.test\.tsx?$/.test(nazwa) ? [rel] : [];
  });
}

const tresc = (plik: string) => readFileSync(join(ROOT, plik), 'utf8');

describe('proforma i oferta poza KSeF i poza przychodem', () => {
  it('moduł proform istnieje (strażnik widzi pliki)', () => {
    const wlasne = MODUL_PROFORM.flatMap(pliki);
    expect(wlasne.length).toBeGreaterThan(8);
  });

  it('KSeF, KPiR, JPK, raporty, pulpit, przypomnienia i API nie sięgają po proformy ani oferty', () => {
    const naruszenia = MODULY_PRZYCHODU.flatMap(pliki).filter((plik) =>
      /sales_quote|lib\/proformy|app\/actions\/proformy|['"`]\/proformy/.test(tresc(plik)),
    );
    expect(naruszenia).toEqual([]);
  });

  it('moduł proform nie woła KSeF, generatorów XML, kolejki zadań, eksportów ani ksiąg', () => {
    const zakazane = /from ['"]@\/lib\/(ksef|xml\/fa3|jobs|exports|ksiegowosc|categorization|reminders|overdue|reports|dashboard)\b|from ['"]@\/lib\/invoices\/ksef-|enqueueKsefSubmitAfterDraft|invoiceSubmitRequested/;
    const naruszenia = MODUL_PROFORM.flatMap(pliki).filter((plik) => zakazane.test(tresc(plik)));
    expect(naruszenia).toEqual([]);
  });

  it('moduł proform nie zapisuje faktur, pozycji faktur ani wpłat (tylko czyta powiązane faktury)', () => {
    const naruszenia = MODUL_PROFORM.flatMap(pliki).filter((plik) => {
      const kod = tresc(plik);
      const tabeleFaktur = /\.from\(\s*['"](invoices|invoice_line_items|payments)['"]\s*\)/.test(kod);
      return tabeleFaktur && /\.(insert|upsert|update|delete)\(/.test(kod);
    });
    expect(naruszenia).toEqual([]);
  });
});
