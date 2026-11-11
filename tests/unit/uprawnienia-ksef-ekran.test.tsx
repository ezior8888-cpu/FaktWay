import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 6.2, część 4: sekcja „Uprawnienie dla biura rachunkowego w KSeF”
 * w Ustawieniach, zakładka Księgowa (strona tylko dla właściciela).
 *
 * Prawdziwe: komponent sekcji, model stanów, odczyt danych sekcji
 * (`wczytajSekcjeUprawnien`) i strona zakładki. Zastąpione: akcje serwerowe,
 * router, toasty, flaga, baza (atrapa klienta) i pozostałe sekcje zakładki.
 * Decyzja D1 planu: nowa sekcja z istniejących komponentów pod linkami dla
 * księgowej; istniejące sekcje bez zmian.
 */

const m = vi.hoisted(() => ({
  flaga: false,
  zapytania: [] as Array<{ tabela: string; filtry: Record<string, unknown> }>,
  firma: null as Record<string, unknown> | null,
  wiersze: [] as Record<string, unknown>[],
  bladListy: null as null | { code: string; message: string },
}));

vi.mock('@/app/actions/uprawnienia-ksef', () => ({
  nadajUprawnienieKsefAction: vi.fn(),
  sprawdzUprawnienieKsefAction: vi.fn(),
  odbierzUprawnienieKsefAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/feature-flags/global-flags', () => ({
  getGlobalFlag: vi.fn(async (flaga: string) => flaga === 'ksefPermissionsEnabled' && m.flaga),
  getGlobalFlagForExecution: vi.fn(async () => m.flaga),
}));

const FIRMA = '0a0b0c0d-0000-4000-8000-0000000000aa';
const NIP_BIURA = '1111111111';
const NAZWA = 'Biuro Rachunkowe Testowe sp. z o.o.';
const TERAZ = '2026-11-11T12:00:00.000Z';

type Wiersz = import('@/lib/accountant/uprawnienia-ksef').UprawnienieBiura;
type Sekcja = import('@/lib/accountant/uprawnienia-ksef').SekcjaUprawnien;

function wiersz(pola: Partial<Wiersz> = {}): Wiersz {
  return {
    id: '0a0b0c0d-1111-4000-8000-000000000001',
    nip: NIP_BIURA,
    nazwa: NAZWA,
    zakres: 'odczyt',
    przekazanie: true,
    stan: 'granted',
    kodKsef: 200,
    opisKsef: 'Operacja zakończona sukcesem',
    kodBledu: null,
    rozpoczeto: '2026-11-11T11:58:00.000Z',
    sprawdzono: '2026-11-11T11:58:05.000Z',
    nadano: '2026-11-11T11:58:05.000Z',
    odebrano: null,
    ...pola,
  };
}

function sekcja(pola: Partial<Sekcja> = {}): Sekcja {
  return {
    srodowisko: 'test',
    polaczono: true,
    nipFirmy: '1234567890',
    lista: { rodzaj: 'wiersze', wiersze: [] },
    teraz: TERAZ,
    ...pola,
  };
}

/** Kwoty i daty po polsku mają twardą spację; testy porównują zwykłą. */
const norm = (html: string) => html.replace(/ /g, ' ');
/** Sam tekst widoczny dla klienta (bez znaczników i atrybutów). */
const tekst = (html: string) => html.replace(/<[^>]+>/g, ' ');

async function ekran(s: Sekcja) {
  const { UprawnieniaKsefBiura } = await import('@/components/settings/uprawnienia-ksef');
  return norm(renderToStaticMarkup(<UprawnieniaKsefBiura firma={FIRMA} sekcja={s} />));
}

/** Przycisk z danym tekstem (ikona i tekst w jednym `<button>`). */
const przycisk = (napis: string) => new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*${napis}(?:(?!</button>)[\\s\\S])*</button>`);

describe('sekcja: formularz nadania', () => {
  it('połączona firma, pusta lista: NIP, nazwa, zakres, przekazanie pracownikom i przycisk', async () => {
    const html = await ekran(sekcja());

    expect(html).toContain('Uprawnienie dla biura rachunkowego w KSeF');
    expect(html).toMatch(/id="ksef-biuro-nip"/);
    expect(html).toMatch(/id="ksef-biuro-nazwa"/);
    expect(html).toContain('Przeglądanie faktur');
    expect(html).toContain('Przeglądanie i wystawianie faktur');
    expect(html).toMatch(/pracownik/);
    expect(html).toMatch(przycisk('Nadaj uprawnienie w KSeF'));
    expect(html).toMatch(/bez logowania do Aplikacji Podatnika/);
    expect(html).toMatch(/Żadne biuro nie ma jeszcze uprawnienia/);
  });

  it('środowisko testowe KSeF: informacja, że uprawnienie działa tylko w KSeF testowym', async () => {
    expect(await ekran(sekcja())).toMatch(/testow/);
    expect(await ekran(sekcja({ srodowisko: 'production' }))).not.toMatch(/KSeF testow/);
  });

  it('firma bez połączenia z KSeF: wskazówka z linkiem do ustawień KSeF, bez formularza', async () => {
    const html = await ekran(sekcja({ polaczono: false }));

    expect(html).toContain('href="/settings/ksef"');
    expect(html).not.toMatch(przycisk('Nadaj uprawnienie w KSeF'));
  });

  it('przed migracją 00195 (brak tabeli): „po najbliższej aktualizacji”, bez formularza', async () => {
    const html = await ekran(sekcja({ lista: { rodzaj: 'niedostepna' } }));

    expect(html).toMatch(/po najbliższej aktualizacji/);
    expect(html).not.toMatch(przycisk('Nadaj uprawnienie w KSeF'));
  });

  it('błąd odczytu listy: komunikat, bez formularza (stan nieznany)', async () => {
    const html = await ekran(sekcja({ lista: { rodzaj: 'blad' } }));

    expect(html).toMatch(/Nie udało się wczytać/);
    expect(html).not.toMatch(przycisk('Nadaj uprawnienie w KSeF'));
  });

  it('brak bezpiecznie ustawionego środowiska KSeF: komunikat, bez formularza', async () => {
    const html = await ekran(sekcja({ srodowisko: null }));

    expect(html).toMatch(/środowiska KSeF/);
    expect(html).not.toMatch(przycisk('Nadaj uprawnienie w KSeF'));
  });
});

describe('sekcja: lista biur i stany', () => {
  it.each([
    ['nadane', { stan: 'granted' }, 'Nadane', 'Odbierz'],
    ['w toku w KSeF', { stan: 'grant_in_progress', kodKsef: 100 }, 'W toku w KSeF', 'Sprawdź stan'],
    ['nie nadano', { stan: 'grant_failed', kodBledu: 'status_420', kodKsef: 420 }, 'Nie nadano', 'Ponów'],
    ['odebrane', { stan: 'revoked', odebrano: '2026-11-11T11:59:00.000Z' }, 'Odebrane', 'Nadaj ponownie'],
    ['odebranie przerwane', { stan: 'revoke_pending', rozpoczeto: '2026-11-11T11:50:00.000Z' }, 'Odebranie przerwane', 'Ponów odebranie'],
    ['odbieranie w toku', { stan: 'revoke_in_progress', kodKsef: 100 }, 'Odbieranie w toku', 'Sprawdź stan'],
  ] as const)('%s: odznaka i przycisk', async (_opis, pola, odznaka, napis) => {
    const html = await ekran(sekcja({ lista: { rodzaj: 'wiersze', wiersze: [wiersz(pola as Partial<Wiersz>)] } }));

    expect(html).toContain(NAZWA);
    expect(html).toContain(NIP_BIURA);
    expect(html).toContain(odznaka);
    expect(html).toMatch(przycisk(napis));
  });

  it('nie nadano z kodem 420: przyczyna i wyjście przy wierszu', async () => {
    const html = await ekran(
      sekcja({ lista: { rodzaj: 'wiersze', wiersze: [wiersz({ stan: 'grant_failed', kodBledu: 'status_420', kodKsef: 420, opisKsef: null })] } }),
    );

    expect(html).toMatch(/420/);
    expect(html).toMatch(/Aplikacji Podatnika/);
  });

  it('nadawanie w toku (świeża próba): bez przycisków przy wierszu', async () => {
    const html = await ekran(
      sekcja({ lista: { rodzaj: 'wiersze', wiersze: [wiersz({ stan: 'grant_pending', rozpoczeto: '2026-11-11T11:59:30.000Z' })] } }),
    );

    expect(html).toContain('Nadawanie');
    expect(html).not.toMatch(przycisk('Odbierz'));
    expect(html).not.toMatch(przycisk('Ponów'));
  });

  it('zakres i przekazanie pracownikom widoczne przy wierszu', async () => {
    const html = await ekran(
      sekcja({ lista: { rodzaj: 'wiersze', wiersze: [wiersz({ zakres: 'odczyt_i_wystawianie', przekazanie: false })] } }),
    );

    expect(html).toContain('Przeglądanie i wystawianie faktur');
  });

  it('teksty bez długich myślników', async () => {
    const wszystkie = [
      await ekran(sekcja()),
      await ekran(sekcja({ polaczono: false })),
      await ekran(sekcja({ lista: { rodzaj: 'niedostepna' } })),
      await ekran(sekcja({ lista: { rodzaj: 'blad' } })),
      await ekran(
        sekcja({
          lista: {
            rodzaj: 'wiersze',
            wiersze: [
              wiersz(),
              wiersz({ id: '0a0b0c0d-1111-4000-8000-000000000002', stan: 'grant_failed', kodBledu: 'http_403' }),
              wiersz({ id: '0a0b0c0d-1111-4000-8000-000000000003', stan: 'revoked', kodBledu: 'not_found_in_ksef' }),
            ],
          },
        }),
      ),
    ];
    for (const html of wszystkie) expect(tekst(html)).not.toContain('—');
  });

  it('kolory: tekst odznak i alertów w jasnym motywie bez green-600 i amber-600 (kontrast WCAG AA)', () => {
    const src = readFileSync(join(process.cwd(), 'components/settings/uprawnienia-ksef.tsx'), 'utf8');
    expect(src).not.toMatch(/(?<!dark:)text-(green|amber)-600/);
  });
});

// ─── dane sekcji (flaga, połączenie z KSeF, lista z bazy kluczem sesji) ─

function bazaSesji() {
  return {
    from(tabela: string) {
      const filtry: Record<string, unknown> = {};
      m.zapytania.push({ tabela, filtry });
      const b = {
        select() { return b; },
        eq(k: string, v: unknown) { filtry[k] = v; return b; },
        order() { return b; },
        limit() { return b; },
        maybeSingle() { return Promise.resolve({ data: tabela === 'tenants' ? m.firma : null, error: null }); },
        then(ok: (v: unknown) => unknown, nie?: (e: unknown) => unknown) {
          const wynik = m.bladListy ? { data: null, error: m.bladListy } : { data: m.wiersze, error: null };
          return Promise.resolve(wynik).then(ok, nie);
        },
      };
      return b;
    },
  };
}

const wierszBazy = (pola: Record<string, unknown> = {}) => ({
  id: '0a0b0c0d-1111-4000-8000-000000000001',
  ksef_environment: 'test',
  subject_nip: NIP_BIURA,
  subject_name: NAZWA,
  scopes: ['InvoiceRead'],
  can_delegate: true,
  status: 'granted',
  operation_references: [],
  ksef_status_code: 200,
  ksef_status_description: 'Operacja zakończona sukcesem',
  error_code: null,
  claimed_at: '2026-11-11T11:58:00.000Z',
  checked_at: '2026-11-11T11:58:05.000Z',
  granted_at: '2026-11-11T11:58:05.000Z',
  revoked_at: null,
  ...pola,
});

beforeEach(() => {
  m.flaga = false;
  m.zapytania = [];
  m.firma = { nip: '1234567890', has_ksef_credentials: true, ksef_verified_at: '2026-11-01T10:00:00.000Z', ksef_verified_environment: 'test' };
  m.wiersze = [wierszBazy()];
  m.bladListy = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dane sekcji', () => {
  async function dane() {
    const { wczytajSekcjeUprawnien } = await import('@/lib/accountant/uprawnienia-ksef-dane');
    return wczytajSekcjeUprawnien(bazaSesji(), FIRMA);
  }

  it('flaga wyłączona: bez sekcji i bez zapytań do bazy', async () => {
    expect(await dane()).toBeNull();
    expect(m.zapytania).toEqual([]);
  });

  it('flaga włączona: lista firmy w bieżącym środowisku KSeF, połączenie z KSeF potwierdzone', async () => {
    m.flaga = true;

    const s = await dane();

    expect(s).toMatchObject({ srodowisko: 'test', polaczono: true, nipFirmy: '1234567890' });
    expect(s!.lista).toEqual({ rodzaj: 'wiersze', wiersze: [expect.objectContaining({ nip: NIP_BIURA, nazwa: NAZWA, zakres: 'odczyt', stan: 'granted' })] });
    const lista = m.zapytania.find((z) => z.tabela === 'ksef_permission_grants')!;
    expect(lista.filtry).toMatchObject({ tenant_id: FIRMA, ksef_environment: 'test' });
  });

  it('wiersz spoza znanych stanów albo zakresów jest pomijany', async () => {
    m.flaga = true;
    m.wiersze = [wierszBazy(), wierszBazy({ id: 'x', status: 'nieznany' }), wierszBazy({ id: 'y', scopes: ['InvoiceWrite'] })];

    const s = await dane();

    expect(s!.lista).toMatchObject({ rodzaj: 'wiersze', wiersze: [expect.objectContaining({ id: '0a0b0c0d-1111-4000-8000-000000000001' })] });
    expect((s!.lista as { wiersze: unknown[] }).wiersze).toHaveLength(1);
  });

  it.each(['PGRST205', '42P01'])('brak tabeli przed 00195 (%s): sekcja niedostępna', async (kod) => {
    m.flaga = true;
    m.bladListy = { code: kod, message: 'relation does not exist' };

    expect((await dane())!.lista).toEqual({ rodzaj: 'niedostepna' });
  });

  it('inny błąd odczytu: błąd listy', async () => {
    m.flaga = true;
    m.bladListy = { code: '08006', message: 'connection failure' };

    expect((await dane())!.lista).toEqual({ rodzaj: 'blad' });
  });

  it('połączenie potwierdzone w innym środowisku albo bez certyfikatu: niepołączona', async () => {
    m.flaga = true;
    m.firma = { nip: '1234567890', has_ksef_credentials: true, ksef_verified_at: '2026-11-01T10:00:00.000Z', ksef_verified_environment: 'production' };
    expect((await dane())!.polaczono).toBe(false);

    m.firma = { nip: '1234567890', has_ksef_credentials: false, ksef_verified_at: '2026-11-01T10:00:00.000Z', ksef_verified_environment: 'test' };
    expect((await dane())!.polaczono).toBe(false);
  });

  it('brak KSEF_ENV: sekcja bez środowiska, bez listy z bazy', async () => {
    m.flaga = true;
    vi.stubEnv('KSEF_ENV', '');

    const s = await dane();

    expect(s).toMatchObject({ srodowisko: null });
    expect(m.zapytania.find((z) => z.tabela === 'ksef_permission_grants')).toBeUndefined();
  });
});

// ─── strona zakładki: sekcja tylko przy włączonej fladze ────────────────

vi.mock('@/lib/supabase/page-context', () => ({
  getPageContextWithRole: vi.fn(async () => ({ supabase: bazaSesji(), tenantId: FIRMA, role: 'owner' })),
}));
vi.mock('@/lib/exports/tax-office', () => ({ readTenantTaxOffice: vi.fn(async () => null) }));
vi.mock('@/components/settings/accountant-list', () => ({ AccountantAccessList: () => <div>linki-dla-ksiegowej</div> }));
vi.mock('@/components/exports/co-pilot-settings-form', () => ({ CoPilotSettingsForm: () => <div>co-pilot</div> }));
vi.mock('@/components/settings/tax-office-form', () => ({ TaxOfficeForm: () => <div>urzad</div> }));

describe('strona Ustawienia, Księgowa', () => {
  async function strona() {
    const { default: AccountantAccessPage } = await import('@/app/(dashboard)/settings/accountant/page');
    return norm(renderToStaticMarkup(await AccountantAccessPage()));
  }

  it('flaga wyłączona: bez sekcji uprawnień, reszta zakładki bez zmian', async () => {
    const html = await strona();

    expect(html).toContain('linki-dla-ksiegowej');
    expect(html).not.toContain('Uprawnienie dla biura rachunkowego w KSeF');
  });

  it('flaga włączona: sekcja uprawnień pod linkami dla księgowej', async () => {
    m.flaga = true;

    const html = await strona();

    expect(html).toContain('Uprawnienie dla biura rachunkowego w KSeF');
    expect(html.indexOf('linki-dla-ksiegowej')).toBeLessThan(html.indexOf('Uprawnienie dla biura rachunkowego w KSeF'));
    expect(html).toContain(NAZWA);
  });
});
