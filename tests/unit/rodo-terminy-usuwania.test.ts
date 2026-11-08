import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: vi.fn() }));

import { GDPR_COOLING_OFF_DAYS } from '@/lib/gdpr/deletion';
import { renderPlainText } from '@/lib/legal/doc-model';
import { POLITYKA_PRYWATNOSCI, REGULAMIN, UMOWA_POWIERZENIA } from '@/lib/legal/documents';

/**
 * AUD-74 (decyzja I6): konto usuwa się po 14 dniach na wycofanie decyzji,
 * a dokumenty obiecują „najpóźniej w ciągu miesiąca”. Do 02.10 polityka,
 * strona RODO i okno usuwania konta mówiły o 30 dniach.
 */

const read = (p: string) => readFileSync(p, 'utf8').replace(/\s+/g, ' ');

describe('terminy usuwania konta — kod i dokumenty mówią to samo', () => {
  it('kod: 14 dni na wycofanie decyzji', () => {
    expect(GDPR_COOLING_OFF_DAYS).toBe(14);
  });

  it('polityka prywatności: 14 dni i „najpóźniej w ciągu miesiąca”, bez 30 dni i bez noty „docelowo”', () => {
    // Od 15.10.2026 treść polityki żyje w lib/legal/documents (strona tylko ją
    // renderuje) — sprawdzamy tekst, który widzi klient.
    const text = renderPlainText(POLITYKA_PRYWATNOSCI, 'https://faktway.example').replace(/\s+/g, ' ');
    expect(text).toContain('14 dni');
    expect(text).toContain('najpóźniej w ciągu miesiąca');
    expect(text).not.toContain('obecnie jest to 30 dni');
    expect(text).not.toContain('Uwaga planistyczna');
  });

  it('strona RODO: usunięcie konta najpóźniej w ciągu miesiąca', () => {
    const text = read('app/(marketing)/legal/rodo/page.tsx');
    expect(text).toContain('najpóźniej w ciągu miesiąca');
    expect(text).not.toContain('danych w 30 dni od żądania');
  });

  // Rewizja 15.10.2026: dawny `components/settings/delete-account.tsx` NIE
  // usuwał konta — wołał `requestAccountDeletionAction`, które oznaczało do
  // usunięcia FIRMĘ (30 dni). Ten test wcześniej wymuszał w nim „14 dni”
  // (termin usunięcia konta) i utrwalał pomyłkę. Konto usuwa sekcja RODO.
  it('usuwanie konta (sekcja RODO): 14 dni na wycofanie decyzji', () => {
    const text = read('app/(dashboard)/settings/account/_components/gdpr-section.tsx');
    expect(text).toContain(`${GDPR_COOLING_OFF_DAYS}-dniowym okresem na wycofanie decyzji`);
  });

  // Od 22.10.2026 usunięcie firmy to instrukcja z linkiem do pomocy
  // (`company-deletion.tsx`), bez formularza i akcji serwera.
  it('instrukcja usunięcia firmy mówi, że dotyczy firmy, i nie podaje terminu usunięcia konta', () => {
    const text = read('components/settings/company-deletion.tsx');
    expect(text).toContain('Usuń organizację (firmę)');
    expect(text).not.toContain(`nieodwracalna po ${GDPR_COOLING_OFF_DAYS} dniach`);
  });
});

/**
 * Kopie zapasowe: umowa powierzenia (§ 9 ust. 2) i polityka prywatności mówią,
 * jak długo usunięte dane mogą zostać w kopiach. Do 15.10.2026 umowa obiecywała
 * „nie dłużej niż 30 dni”, a job trzymał kopie tygodniowe 56 dni. Terminy
 * czytamy z kodu joba, żeby zmiana retencji wymusiła zmianę dokumentów.
 */
describe('kopie zapasowe — dokumenty zgodne z retencją w kodzie', () => {
  const runner = readFileSync('lib/jobs/runners/cleanup-old-backups.ts', 'utf8');
  const constant = (name: string) => {
    const m = runner.match(new RegExp(`const ${name} = (\\d+);`));
    if (!m) throw new Error(`brak stałej ${name} w cleanup-old-backups.ts`);
    return Number(m[1]);
  };
  const daily = constant('DAILY_RETENTION_DAYS');
  const weekly = constant('WEEKLY_RETENTION_DAYS');
  const plain = (doc: typeof UMOWA_POWIERZENIA) =>
    renderPlainText(doc, 'https://faktway.example').replace(/\s+/g, ' ');

  it('kopie tygodniowe to pełne tygodnie (dokumenty podają je w tygodniach)', () => {
    expect(weekly % 7).toBe(0);
  });

  it.each([
    ['umowa powierzenia', UMOWA_POWIERZENIA],
    ['polityka prywatności', POLITYKA_PRYWATNOSCI],
  ] as const)('%s: podaje terminy kopii dziennych i tygodniowych z kodu', (_name, doc) => {
    const text = plain(doc);
    expect(text).toContain(`dzienne do ${daily} dni`);
    expect(text).toContain(`tygodniowe do ${weekly / 7} tygodni`);
  });

  it('umowa powierzenia: cykl nadpisywania kopii nie krótszy niż najdłuższa retencja w kodzie', () => {
    const m = plain(UMOWA_POWIERZENIA).match(/w cyklu nadpisywania kopii, nie dłuższym niż (\d+) dni/);
    expect(m, 'brak zdania o cyklu nadpisywania kopii w § 9').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(Math.max(daily, weekly));
  });
});

/**
 * Usunięcie FIRMY nie działa w aplikacji: `tenants.deleted_at`, `hard_delete_at`
 * i `is_active` nie sprawdza logowanie, RLS (`is_member_of`,
 * `get_current_tenant_id`) ani żaden job, a subskrypcji nikt nie anuluje.
 * Od 15.10.2026 samoobsługa jest wstrzymana, a usunięcie firmy idzie przez
 * pomoc techniczną (od 22.10 ekran to sama instrukcja z linkiem `mailto:`,
 * bez formularza i akcji). Ekrany i dokumenty nie mogą więc obiecywać
 * wyłączenia firmy ani usunięcia danych w terminie liczonym od kliknięcia.
 * Test sprawdza teksty; wyrenderowany ekran sprawdza
 * `usuwanie-firmy-wstrzymane.test.tsx`.
 */
describe('usuwanie firmy — teksty nie obiecują mechanizmu, którego nie ma', () => {
  // Komentarze w kodzie celowo cytują stare sformułowania — wycinamy je.
  const stripComments = (src: string) =>
    src.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const visible = (p: string) => stripComments(readFileSync(p, 'utf8')).replace(/\s+/g, ' ');

  it('wycinanie komentarzy nie zjada kodu', () => {
    expect(stripComments('a /* x */ b {/* y */} c // z\nd https://e.pl')).toBe('a   b   c \nd https://e.pl');
  });

  const screens = [
    'components/settings/company-deletion.tsx',
    'app/(dashboard)/settings/page.tsx',
    'app/(dashboard)/settings/account/page.tsx',
  ];

  it.each(screens)('%s: bez „od razu wyłączona”, terminów usunięcia i „nieodwracalne”', (file) => {
    const text = visible(file);
    expect(text).not.toMatch(/od razu wyłączon/);
    expect(text).not.toMatch(/w ciągu kolejnych 30 dni/);
    expect(text).not.toMatch(/30 dni na zmianę decyzji/);
    expect(text).not.toMatch(/nieodwracaln/i);
    expect(text).not.toContain('Potwierdź usunięcie konta');
  });

  it('components/settings/company-deletion.tsx: kieruje do pomocy technicznej', () => {
    const text = visible('components/settings/company-deletion.tsx');
    expect(text).toContain('SUPPORT_EMAIL');
    expect(text).toContain('przez pomoc techniczną');
  });

  it('pomoc (czyta ją też asystent AI): usunięcie organizacji przez pomoc, serwery w Norymberdze', () => {
    const rodo = read('content/help/rodo-i-usuwanie-konta.mdx');
    expect(rodo).toContain('przez pomoc techniczną');
    expect(rodo).not.toContain('kasuje firmę z systemu (osobna sekcja');
    expect(rodo).not.toContain('Frankfurt');
    expect(read('content/help/role-i-uprawnienia.mdx')).not.toContain('może usunąć organizację');
  });

  it('regulamin i umowa powierzenia: usunięcie Organizacji zlecane e-mailem, bez „od razu wyłączona”', () => {
    for (const doc of [REGULAMIN, UMOWA_POWIERZENIA]) {
      const text = renderPlainText(doc, 'https://faktway.example').replace(/\s+/g, ' ');
      expect(text, doc.title).not.toMatch(/od razu wyłączon/);
      expect(text, doc.title).not.toContain('usunięcie Organizacji (Ustawienia');
      expect(text, doc.title).not.toContain('przez usunięcie Organizacji');
    }
  });
});
