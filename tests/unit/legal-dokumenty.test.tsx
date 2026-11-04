import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: vi.fn(), headers: vi.fn() }));

import { ATTRIBUTION_COOKIE } from '@/lib/analytics/attribution';
import { CONSENT_KEY, CONSENT_META_KEY } from '@/lib/analytics/consent';
import { GDPR_COOLING_OFF_DAYS } from '@/lib/gdpr/deletion-constants';
import {
  listLabel,
  parseInline,
  renderPlainText,
  type Block,
  type LegalDocument,
  type ListEntry,
} from '@/lib/legal/doc-model';
import {
  CONTRACT_DOCUMENTS,
  LEGAL_DOCUMENTS,
  POLITYKA_COOKIES,
  POLITYKA_PRYWATNOSCI,
  REGULAMIN,
  UMOWA_POWIERZENIA,
} from '@/lib/legal/documents';
import {
  LEGAL_ENTITY,
  isLegalEntityComplete,
  missingLegalEntityFields,
  type LegalEntity,
} from '@/lib/legal/entity';
import { contractAttachments } from '@/lib/legal/plain-text';
import { SUBPROCESSORS, subprocessorsFor } from '@/lib/legal/subprocessors';
import { CHECKOUT_STATEMENT, MARKETING_STATEMENT, TERMS_STATEMENT } from '@/lib/legal/versions';
import { ACTIVE_ORG_COOKIE } from '@/lib/supabase/active-org';
import { THEME_STORAGE_KEY } from '@/lib/theme/theme';

/**
 * Dokumenty prawne (15.10.2026). Strażnicy pilnują, żeby treść nie rozjechała
 * się z kodem — do tej daty polityka wymieniała dostawców, których od miesiąca
 * nie było (Vercel, Inngest, Supabase Cloud), a regulamin miał „[nazwa firmy]”.
 */

const ALL_DOCS: LegalDocument[] = [REGULAMIN, UMOWA_POWIERZENIA, POLITYKA_PRYWATNOSCI, POLITYKA_COOKIES];
const SITE = 'https://faktway.example';
const text = (doc: LegalDocument) => renderPlainText(doc, SITE);

function allStrings(doc: LegalDocument): string[] {
  const out: string[] = [...(doc.summary ?? [])];
  const walk = (items: ListEntry[]) => {
    for (const e of items) {
      if (typeof e === 'string') out.push(e);
      else {
        out.push(e.text);
        walk(e.items ?? []);
      }
    }
  };
  const block = (b: Block) => {
    if (b.type === 'p' || b.type === 'note') out.push(b.text);
    else if (b.type === 'ol' || b.type === 'ul') walk(b.items);
    else out.push(...b.head, ...b.rows.flat());
  };
  for (const s of doc.sections) {
    out.push(s.title);
    s.blocks.forEach(block);
  }
  return out;
}

const COMPLETE: LegalEntity = {
  ...LEGAL_ENTITY,
  name: 'Fikcyjna Spółka z o.o.',
  legalForm: 'sp_z_oo',
  street: 'ul. Testowa 1',
  postalCode: '00-001',
  city: 'Testowo',
  nip: '1234567890',
  regon: '123456789',
  krs: '0000000000',
  registryCourt: 'Sąd Rejonowy Testowy',
  shareCapital: '5 000 zł',
};

describe('znaczniki w tekście dokumentu', () => {
  it('pogrubienie, link i zwykły nawias kwadratowy', () => {
    expect(parseInline('a **b** [c](/d) [DO UZUPEŁNIENIA: x] e')).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'bold', value: 'b' },
      { kind: 'text', value: ' ' },
      { kind: 'link', value: 'c', href: '/d' },
      { kind: 'text', value: ' [DO UZUPEŁNIENIA: x] e' },
    ]);
  });

  it('nawias pola do uzupełnienia PRZED linkiem nie wciąga tekstu do linku', () => {
    // Rewizja 15.10: § 13 ust. 2 regulaminu („adres [DO UZUPEŁNIENIA: …] … ze
    // [wzoru formularza](#zalacznik-1)”) renderował pół zdania jako link.
    expect(parseInline('adres [DO UZUPEŁNIENIA: ulica], ze [wzoru](#z), koniec')).toEqual([
      { kind: 'text', value: 'adres [DO UZUPEŁNIENIA: ulica], ze ' },
      { kind: 'link', value: 'wzoru', href: '#z' },
      { kind: 'text', value: ', koniec' },
    ]);
    const t = text(REGULAMIN);
    expect(t).not.toMatch(/adres DO UZUPEŁNIENIA/);
    expect(t).not.toContain('ze [wzoru formularza');
  });

  it('niedomknięte pogrubienie zostaje tekstem', () => {
    expect(parseInline('a **b')).toEqual([{ kind: 'text', value: 'a **b' }]);
  });

  it('numeracja: ustęp „1.”, punkt „1)”, litera „a)”', () => {
    expect([listLabel(0, 0), listLabel(1, 1), listLabel(2, 2)]).toEqual(['1.', '2)', 'c)']);
  });

  it('wersja tekstowa rozwija linki do pełnych adresów i numeruje punkty', () => {
    const doc: LegalDocument = {
      slug: 'x', title: 'Próba', version: '2026-01-01',
      sections: [{ id: 's', title: '§ 1.', blocks: [{ type: 'ol', items: [{ text: 'Zob. [Regulamin](/legal/regulamin).', items: ['pierwszy'] }] }] }],
    };
    const out = renderPlainText(doc, SITE);
    expect(out).toContain('1. Zob. Regulamin (https://faktway.example/legal/regulamin).');
    expect(out).toContain('   1) pierwszy');
    expect(out).toContain('\r\n');
  });
});

describe('dane usługodawcy', () => {
  it('spółka z KRS wymaga numeru KRS, sądu i kapitału', () => {
    expect(missingLegalEntityFields({ ...COMPLETE, krs: null, shareCapital: '' })).toEqual([
      'numer KRS',
      'kapitał zakładowy',
    ]);
    expect(isLegalEntityComplete(COMPLETE)).toBe(true);
  });

  it('JDG nie potrzebuje KRS', () => {
    expect(missingLegalEntityFields({ ...COMPLETE, legalForm: 'jdg', krs: null, registryCourt: null, shareCapital: null })).toEqual([]);
  });

  it('dokumenty oznaczają brakujące dane, dopóki są niepełne — i tylko wtedy', () => {
    const regulamin = text(REGULAMIN);
    if (isLegalEntityComplete()) {
      expect(regulamin).not.toContain('[DO UZUPEŁNIENIA');
    } else {
      expect(regulamin).toContain('[DO UZUPEŁNIENIA');
    }
  });
});

describe('treść odpowiada rzeczywistości', () => {
  // Słowa, które były w dokumentach do 15.10.2026, a nie są prawdą.
  const STALE = ['Vercel', 'Inngest', 'Frankfurt', 'Glacier', 'Cloudflare R2', 'TWÓJ_NIP', '[nazwa firmy]', '99.9', '99,9', 'AES-256', 'Supabase (Frankfurt)'];

  it.each(ALL_DOCS.map((d) => [d.slug, d] as const))('%s: bez nieaktualnych obietnic i dostawców', (_slug, doc) => {
    const t = text(doc);
    for (const word of STALE) expect(t, word).not.toContain(word);
  });

  // Nazwa usługi zmieniona 17.10.2026 (FaktFlow → FaktWay, faktway.pl).
  // Dokument umowy z nieaktualną nazwą usługi i adresem to błąd w umowie.
  // Dawna domena może wystąpić tylko jako adres poczty, który dalej działa.
  it.each(ALL_DOCS.map((d) => [d.slug, d] as const))('%s: nazwa usługi FaktWay, bez dawnej nazwy', (_slug, doc) => {
    const t = text(doc);
    // Polityka cookies nie wymienia nazwy usługi w ogóle — reszta musi.
    if (doc !== POLITYKA_COOKIES) expect(t).toContain('FaktWay');
    expect(t).not.toContain('FaktFlow');
    expect(t.replace(/@faktflow\.pl/g, '')).not.toMatch(/faktflow\.pl/i);
  });

  // Zakładki ustawień zmieniły nazwy z planem Finora (20.10.2026: „Subskrypcja
  // i rozliczenia” → „Abonament”, „Konto i firma” → „Konto i dane (RODO)”).
  // Dokument, pomoc albo komunikat, który odsyła do nieistniejącej zakładki,
  // zostawia klienta bez drogi (np. do anulowania abonamentu).
  it('każde „Ustawienia → X” w dokumentach, pomocy i komunikatach to istniejąca zakładka', () => {
    const tabs = [...readFileSync('components/settings/finora/settings-tabs.ts', 'utf8').matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
    expect(tabs.length).toBeGreaterThan(5);
    const sources: Array<[string, string]> = [
      ...ALL_DOCS.map((d) => [d.slug, text(d)] as [string, string]),
      ...readdirSync('content/help').map((f) => [`content/help/${f}`, readFileSync(`content/help/${f}`, 'utf8')] as [string, string]),
      ...['components/settings/company-deletion.tsx', 'app/(dashboard)/settings/account/page.tsx', 'app/(dashboard)/settings/account/_components/gdpr-section.tsx'].map(
        (f) => [f, readFileSync(f, 'utf8')] as [string, string],
      ),
    ];
    const wrong: string[] = [];
    for (const [name, src] of sources) {
      const flat = src.replace(/\s+/g, ' ');
      for (const m of flat.matchAll(/Ustawienia → /g)) {
        const rest = flat.slice(m.index + m[0].length);
        // Bez rozróżniania wielkości liter: „Flo” i zakładka „FLO” to to samo miejsce.
        if (!tabs.some((t) => rest.toLowerCase().startsWith(t.toLowerCase()))) wrong.push(`${name}: „Ustawienia → ${rest.slice(0, 30)}…”`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('strona RODO: bez nieaktualnych obietnic (treść widoczna dla klienta)', async () => {
    const GdprPage = (await import('@/app/(marketing)/legal/rodo/page')).default;
    const t = renderToStaticMarkup(GdprPage());
    for (const word of ['Vercel', 'Frankfurt', 'AES-256', 'Brak cookies analitycznych', 'Pobierz pdf']) {
      expect(t, word).not.toContain(word);
    }
    expect(t).toContain('najpóźniej w ciągu miesiąca');
  });

  it('polityka prywatności wymienia każdego dostawcę z listy', () => {
    const t = text(POLITYKA_PRYWATNOSCI);
    for (const s of SUBPROCESSORS) expect(t, s.name).toContain(s.name);
  });

  it('załącznik umowy powierzenia = dostawcy z dostępem do danych klientów, nikt więcej', () => {
    const t = text(UMOWA_POWIERZENIA);
    for (const s of SUBPROCESSORS) {
      if (s.roles.includes('client_data')) expect(t, s.name).toContain(s.name);
      else expect(t, s.name).not.toContain(s.name);
    }
    expect(subprocessorsFor('client_data').length).toBeGreaterThan(0);
  });

  it('polityka cookies wymienia klucze, których kod naprawdę używa', () => {
    const t = text(POLITYKA_COOKIES);
    for (const key of [CONSENT_KEY, CONSENT_META_KEY, ATTRIBUTION_COOKIE, ACTIVE_ORG_COOKIE, THEME_STORAGE_KEY, 'install-prompt-dismissed-at']) {
      expect(t, key).toContain(key);
    }
  });

  // Od 11.2026 zdarzenia z serwera wymagają zgody tak samo jak przeglądarka.
  it('dokumenty nie obiecują już analityki bez zgody i opisują ciasteczko źródła wejścia', () => {
    const privacy = text(POLITYKA_PRYWATNOSCI);
    expect(privacy).not.toContain('także wobec statystyk po stronie serwera');
    expect(privacy).toMatch(/zdarzenia z serwera[^|]*wyłącznie za zgodą|wyłącznie za zgodą[^|]*zdarzenia z serwera/i);
    expect(privacy).toContain('źródło wejścia');
    const cookies = text(POLITYKA_COOKIES);
    expect(cookies).not.toContain('Analityka nie zapisuje plików cookies');
    expect(cookies).toContain('90 dni');
    expect(cookies).toContain('Ustawienia → Konto i dane');
    const posthog = SUBPROCESSORS.find((s) => s.name === 'PostHog, Inc.');
    expect(posthog?.purpose).toContain('po wyrażeniu zgody');
    expect(posthog?.purpose).not.toContain('w przeglądarce wyłącznie');
  });

  it('terminy usuwania konta zgodne z kodem', () => {
    expect(text(POLITYKA_PRYWATNOSCI)).toContain(`${GDPR_COOLING_OFF_DAYS} dni`);
    expect(text(POLITYKA_PRYWATNOSCI)).toContain('najpóźniej w ciągu miesiąca');
  });
});

describe('elementy wymagane przepisami', () => {
  const ids = (doc: LegalDocument) => doc.sections.map((s) => s.id);

  it('regulamin: art. 8 ust. 3 u.ś.u.d.e., prawo odstąpienia z wzorem formularza, DSA, AI', () => {
    expect(ids(REGULAMIN)).toEqual(expect.arrayContaining([
      'uslugi', 'wymagania-techniczne', 'zasady-korzystania', 'zawarcie-umowy', 'rozwiazanie',
      'reklamacje', 'odstapienie', 'zalacznik-1', 'funkcje-ai',
    ]));
    const t = text(REGULAMIN);
    expect(t).toContain('14 dni');
    expect(t).toContain('punktem kontaktowym');
    expect(t).toContain('asystent AI, nie człowiek');
  });

  it('umowa powierzenia: elementy art. 28 ust. 3 RODO', () => {
    expect(ids(UMOWA_POWIERZENIA)).toEqual(expect.arrayContaining([
      'przedmiot', 'zakres', 'polecenia', 'bezpieczenstwo', 'podprocesorzy', 'pomoc', 'naruszenia', 'koniec', 'audyt', 'srodki',
    ]));
  });

  it('polityka prywatności: prawo skargi do Prezesa UODO i podstawy prawne', () => {
    const t = text(POLITYKA_PRYWATNOSCI);
    expect(t).toContain('Prezesa Urzędu Ochrony Danych Osobowych');
    for (const basis of ['lit. a', 'lit. b', 'lit. c', 'lit. f']) expect(t).toContain(`art. 6 ust. 1 ${basis}`);
  });
});

describe('linki w dokumentach prowadzą do istniejących stron', () => {
  // Trasy z app/**/page.tsx bez grup „(…)” — i trasy z route.ts.
  function appRoutes(): Set<string> {
    const routes = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name === 'page.tsx' || name === 'route.ts') {
          const segments = path.relative('app', dir).split(path.sep).filter((s) => s && !s.startsWith('('));
          routes.add('/' + segments.join('/'));
        }
      }
    };
    walk('app');
    return routes;
  }

  it('każdy link wewnętrzny (także w oświadczeniach) ma stronę', () => {
    const routes = appRoutes();
    const strings = [
      ...ALL_DOCS.flatMap(allStrings),
      TERMS_STATEMENT.text, MARKETING_STATEMENT.text, CHECKOUT_STATEMENT.text,
    ];
    const hrefs = strings.flatMap((s) => parseInline(s).flatMap((t) => (t.kind === 'link' ? [t.href] : [])));
    const internal = hrefs.filter((h) => h.startsWith('/')).map((h) => h.split('#')[0]);
    expect(internal.length).toBeGreaterThan(5);
    for (const href of internal) expect(routes.has(href), href).toBe(true);
    for (const d of LEGAL_DOCUMENTS) expect(routes.has(d.href), d.href).toBe(true);
  });

  it('kotwice do sekcji w tym samym dokumencie istnieją', () => {
    for (const doc of ALL_DOCS) {
      const ids = new Set(doc.sections.map((s) => s.id));
      const anchors = allStrings(doc).flatMap((s) => parseInline(s).flatMap((t) => (t.kind === 'link' && t.href.startsWith('#') ? [t.href.slice(1)] : [])));
      for (const a of anchors) expect(ids.has(a), `${doc.slug}#${a}`).toBe(true);
    }
  });
});

describe('trwały nośnik', () => {
  it('mail dostaje regulamin i umowę powierzenia jako pliki UTF-8 z BOM', () => {
    const files = contractAttachments();
    expect(files.map((f) => f.filename)).toEqual(CONTRACT_DOCUMENTS.map((d) => `FaktWay-${d.slug}-${d.version}.txt`));
    for (const f of files) {
      expect([...f.content.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(f.content.toString('utf8')).toContain('Usługodawca:');
    }
    expect(files[0].content.toString('utf8')).toContain('Załącznik nr 1. Wzór formularza odstąpienia od umowy');
  });
});
