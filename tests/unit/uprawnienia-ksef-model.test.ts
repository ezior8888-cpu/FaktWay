import { describe, expect, it } from 'vitest';

/**
 * Krok 6.2, część 4 planu kompletnej aplikacji: uprawnienie biura rachunkowego
 * w KSeF nadawane i odbierane z FaktWay. Ten plik sprawdza czysty model
 * (bez sieci i bazy): NIP biura z sumą kontrolną, nazwa biura w granicach
 * schematu KSeF (`EntityDetails.fullName`, 5-90 znaków), zakres (InvoiceRead,
 * opcjonalnie InvoiceWrite), opis dla KSeF (`description`, 5-256 znaków),
 * stany z bazy (00195) z przyciskami i komunikaty z nazwą biura i tym, co zrobić.
 *
 * Źródło pól: specyfikacja OpenAPI KSeF 2.0 TEST
 * (https://api-test.ksef.mf.gov.pl/docs/v2/openapi.json, `EntityPermissionsGrantRequest`,
 * `EntityPermissionType`, `PermissionsOperationStatusResponse`).
 */

const FIRMA = '0a0b0c0d-0000-4000-8000-0000000000aa';
/** Fikcyjny NIP z poprawną sumą kontrolną (używa go też dokumentacja KSeF). */
const NIP_BIURA = '1111111111';
/** Fikcyjny NIP z konwencji repo: suma kontrolna 10, więc żaden NIP tak nie wygląda. */
const ZLY_NIP = '1234567890';
const NAZWA = 'Biuro Rachunkowe Testowe sp. z o.o.';

async function model() {
  return import('@/lib/accountant/uprawnienia-ksef');
}

const wejscie = (pola: Record<string, unknown> = {}) => ({
  firma: FIRMA,
  nip: NIP_BIURA,
  nazwa: NAZWA,
  zakres: 'odczyt',
  przekazanie: true,
  ...pola,
});

describe('NIP biura', () => {
  it.each([
    ['1111111111', '1111111111'],
    ['111-111-11-11', '1111111111'],
    [' 111 111 11 11 ', '1111111111'],
    ['PL1111111111', '1111111111'],
    ['pl 111-111-11-11', '1111111111'],
    ['5555555555', '5555555555'],
  ])('%s: poprawny, po normalizacji %s', async (wpisany, oczekiwany) => {
    const { poprawnyNipBiura } = await model();
    expect(poprawnyNipBiura(wpisany)).toBe(oczekiwany);
  });

  it.each([
    ['zła suma kontrolna (fikcyjny NIP repo)', ZLY_NIP],
    ['zła suma kontrolna', '1111111112'],
    ['9 cyfr', '111111111'],
    ['11 cyfr', '11111111111'],
    ['zero na początku (wzorzec Nip KSeF)', '0111111111'],
    ['litery', '11111111AB'],
    ['obcy prefiks', 'DE1111111111'],
    ['pusty', ''],
    ['nie napis', 1111111111],
    ['null', null],
  ])('%s: odmowa', async (_opis, wartosc) => {
    const { poprawnyNipBiura } = await model();
    expect(poprawnyNipBiura(wartosc)).toBeNull();
  });
});

describe('formularz nadania (ten sam schemat w przeglądarce i w akcji)', () => {
  it('poprawne dane: NIP i nazwa znormalizowane', async () => {
    const { nadanieUprawnieniaSchema } = await model();
    const wynik = nadanieUprawnieniaSchema.safeParse(wejscie({ nip: 'PL 111-111-11-11', nazwa: `  ${NAZWA.replace(/ /g, '   ')} ` }));
    expect(wynik.success).toBe(true);
    if (!wynik.success) return;
    expect(wynik.data).toEqual({ firma: FIRMA, nip: NIP_BIURA, nazwa: NAZWA, zakres: 'odczyt', przekazanie: true });
  });

  it.each([
    ['NIP z błędną sumą kontrolną', { nip: ZLY_NIP }, 'nip', /suma kontrolna|sumę kontrolną/],
    ['NIP za krótki', { nip: '12345' }, 'nip', /NIP/],
    ['nazwa za krótka', { nazwa: 'Abc' }, 'nazwa', /5/],
    ['nazwa za długa', { nazwa: 'B'.repeat(91) }, 'nazwa', /90/],
    ['nieznany zakres', { zakres: 'wszystko' }, 'zakres', /zakres/i],
    ['przekazanie nie jako tak/nie', { przekazanie: 'tak' }, 'przekazanie', /./],
    ['firma spoza formatu', { firma: 'firma-a' }, 'firma', /./],
  ])('%s: odmowa z komunikatem przy polu', async (_opis, pola, pole, tekst) => {
    const { nadanieUprawnieniaSchema } = await model();
    const wynik = nadanieUprawnieniaSchema.safeParse(wejscie(pola));
    expect(wynik.success).toBe(false);
    if (wynik.success) return;
    const blad = wynik.error.issues.find((i) => i.path[0] === pole);
    expect(blad, pole).toBeDefined();
    expect(blad!.message).toMatch(tekst);
    expect(blad!.message).not.toContain('—');
  });
});

describe('zakres: uprawnienia KSeF (EntityPermissionType)', () => {
  it('odczyt to InvoiceRead, odczyt i wystawianie to InvoiceRead i InvoiceWrite', async () => {
    const { UPRAWNIENIA_ZAKRESU, zakresZUprawnien } = await model();
    expect(UPRAWNIENIA_ZAKRESU.odczyt).toEqual(['InvoiceRead']);
    expect(UPRAWNIENIA_ZAKRESU.odczyt_i_wystawianie).toEqual(['InvoiceRead', 'InvoiceWrite']);
    expect(zakresZUprawnien(['InvoiceRead'])).toBe('odczyt');
    expect(zakresZUprawnien(['InvoiceRead', 'InvoiceWrite'])).toBe('odczyt_i_wystawianie');
    expect(zakresZUprawnien(['InvoiceWrite', 'InvoiceRead'])).toBe('odczyt_i_wystawianie');
  });

  it.each([[['InvoiceWrite']], [[]], [['CollectiveIdentifierManage']], [['InvoiceRead', 'InvoiceRead']], ['InvoiceRead'], [null]])(
    'zestaw spoza dwóch zakresów %j: brak zakresu',
    async (zestaw) => {
      const { zakresZUprawnien } = await model();
      expect(zakresZUprawnien(zestaw)).toBeNull();
    },
  );
});

describe('opis uprawnienia dla KSeF (description, 5-256 znaków)', () => {
  it('nazwa biura i FaktWay, w granicach schematu', async () => {
    const { opisDlaKsef } = await model();
    const opis = opisDlaKsef(NAZWA);
    expect(opis).toContain(NAZWA);
    expect(opis).toContain('FaktWay');
    expect(opis.length).toBeGreaterThanOrEqual(5);
    expect(opis.length).toBeLessThanOrEqual(256);
    expect(opisDlaKsef('B'.repeat(90)).length).toBeLessThanOrEqual(256);
  });
});

type Wiersz = import('@/lib/accountant/uprawnienia-ksef').UprawnienieBiura;
const TERAZ = new Date('2026-11-11T12:00:00.000Z');

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

describe('stan na liście: etykieta, opis i przyciski', () => {
  it.each([
    ['nadane', { stan: 'granted' }, 'Nadane', 'ok', ['odbierz']],
    ['w toku w KSeF', { stan: 'grant_in_progress', kodKsef: 100 }, 'W toku', 'czeka', ['sprawdz']],
    ['nadawanie (świeża próba)', { stan: 'grant_pending', rozpoczeto: '2026-11-11T11:59:00.000Z' }, 'Nadawanie', 'czeka', []],
    ['nadanie przerwane (próba starsza niż 5 minut)', { stan: 'grant_pending', rozpoczeto: '2026-11-11T11:50:00.000Z' }, 'przerwane', 'blad', ['ponow_nadanie']],
    ['nie nadano', { stan: 'grant_failed', kodBledu: 'status_420', kodKsef: 420 }, 'Nie nadano', 'blad', ['ponow_nadanie']],
    ['odbieranie (świeża próba)', { stan: 'revoke_pending', rozpoczeto: '2026-11-11T11:59:00.000Z' }, 'Odbieranie', 'czeka', []],
    ['odebranie przerwane', { stan: 'revoke_pending', rozpoczeto: '2026-11-11T11:50:00.000Z' }, 'przerwane', 'blad', ['ponow_odebranie']],
    ['odbieranie w toku', { stan: 'revoke_in_progress', kodKsef: 100 }, 'Odbieranie w toku', 'czeka', ['sprawdz']],
    ['odebrane', { stan: 'revoked', odebrano: '2026-11-11T11:59:00.000Z' }, 'Odebrane', 'neutralny', ['nadaj_ponownie']],
    ['nie odebrano', { stan: 'revoke_failed', kodBledu: 'still_active' }, 'Nie odebrano', 'blad', ['ponow_odebranie']],
  ] as const)('%s', async (_opis, pola, etykieta, ton, akcje) => {
    const { stanDlaKlienta } = await model();
    const s = stanDlaKlienta(wiersz(pola as Partial<Wiersz>), TERAZ);
    expect(s.etykieta).toContain(etykieta);
    expect(s.ton).toBe(ton);
    expect(s.akcje).toEqual(akcje);
    expect(s.opis.length).toBeGreaterThan(10);
    expect(s.opis).not.toContain('—');
  });

  it('nadane z wystawianiem i przekazaniem: opis mówi o obu', async () => {
    const { stanDlaKlienta } = await model();
    const s = stanDlaKlienta(wiersz({ zakres: 'odczyt_i_wystawianie', przekazanie: true }), TERAZ);
    expect(s.opis).toMatch(/wystawianie/);
    expect(s.opis).toMatch(/pracownik/);
  });

  it('nadane wcześniej z innym ustawieniem przekazania (delegate_mismatch): opis nie podaje wyboru jako faktu', async () => {
    const { stanDlaKlienta } = await model();
    const s = stanDlaKlienta(wiersz({ stan: 'granted', przekazanie: true, kodBledu: 'delegate_mismatch' }), TERAZ);
    expect(s.opis).toMatch(/inne ustawienie przekazania/);
    expect(s.opis).not.toMatch(/z możliwością przekazania/);
    expect(s.akcje).toEqual(['odbierz']);
  });

  it('odebrane bez aktywnego uprawnienia w KSeF: opis mówi, że FaktWay go nie znalazł', async () => {
    const { stanDlaKlienta } = await model();
    const s = stanDlaKlienta(wiersz({ stan: 'revoked', kodBledu: 'not_found_in_ksef' }), TERAZ);
    expect(s.opis).toMatch(/nie było/);
    expect(s.opis).toMatch(/Aplikacji Podatnika/);
  });

  it('nie nadano z kodem 420: opis z nazwą biura, NIP-em i wyjściem', async () => {
    const { stanDlaKlienta } = await model();
    const s = stanDlaKlienta(wiersz({ stan: 'grant_failed', kodBledu: 'status_420', kodKsef: 420, opisKsef: null }), TERAZ);
    expect(s.opis).toContain(NAZWA);
    expect(s.opis).toContain(NIP_BIURA);
    expect(s.opis).toMatch(/420/);
    expect(s.opis).toMatch(/Aplikacji Podatnika/);
  });
});

const BIURO = { nazwa: NAZWA, nip: NIP_BIURA };

describe('komunikaty błędów: nazwa biura, NIP i co zrobić', () => {
  const KODY = [
    'credentials_missing',
    'credentials_read',
    'credentials_internal',
    'session',
    'http_401',
    'http_403',
    'http_429',
    'http_5xx',
    'timeout',
    'network',
    'ksef_21405',
    'ksef_http_404',
    'invalid_response',
    'status_400',
    'status_410',
    'status_420',
    'status_430',
    'status_440',
    'status_450',
    'status_500',
    'status_550',
    'status_999',
    'operation_expired',
    'still_active',
    'unknown',
    'cos_nowego',
  ];

  it.each(KODY.flatMap((kod) => (['nadanie', 'odebranie', 'sprawdzenie'] as const).map((rodzaj) => [kod, rodzaj] as const)))(
    '%s przy operacji „%s”',
    async (kod, rodzaj) => {
      const { komunikatBledu } = await model();
      const tekst = komunikatBledu(kod, rodzaj, BIURO, { kodKsef: null, opisKsef: null, retryAfterMs: null });
      expect(tekst).toContain(NAZWA);
      expect(tekst).toContain(NIP_BIURA);
      // Każdy komunikat mówi, co zrobić (protokół napraw, pkt 4).
      expect(tekst).toMatch(/Spróbuj|Połącz|Sprawdź|Nadaj|Kliknij|napisz do pomocy|Aplikacji Podatnika|Odśwież/);
      expect(tekst).not.toContain('—');
    },
  );

  it('niepewne nadanie (brak odpowiedzi KSeF): nie nada drugi raz, bo najpierw sprawdzi', async () => {
    const { komunikatBledu } = await model();
    for (const kod of ['timeout', 'network', 'http_5xx', 'invalid_response']) {
      expect(komunikatBledu(kod, 'nadanie', BIURO, { kodKsef: null, opisKsef: null, retryAfterMs: null })).toMatch(/drugi raz/);
    }
  });

  it('403 i 420: brak prawa do zarządzania uprawnieniami (CredentialsManage) z wyjściem', async () => {
    const { komunikatBledu } = await model();
    expect(komunikatBledu('http_403', 'nadanie', BIURO, { kodKsef: null, opisKsef: null, retryAfterMs: null })).toMatch(/CredentialsManage/);
    expect(komunikatBledu('status_420', 'nadanie', BIURO, { kodKsef: 420, opisKsef: null, retryAfterMs: null })).toMatch(/certyfikat/);
  });

  it('429: kiedy spróbować ponownie, z Retry-After', async () => {
    const { komunikatBledu } = await model();
    expect(komunikatBledu('http_429', 'nadanie', BIURO, { kodKsef: null, opisKsef: null, retryAfterMs: 120_000 })).toMatch(/za 2 min/);
    expect(komunikatBledu('http_429', 'nadanie', BIURO, { kodKsef: null, opisKsef: null, retryAfterMs: null })).toMatch(/za chwilę/);
  });

  it('status operacji z opisem z KSeF: opis i kod w komunikacie', async () => {
    const { komunikatBledu } = await model();
    const tekst = komunikatBledu('status_450', 'nadanie', BIURO, {
      kodKsef: 450,
      opisKsef: 'Operacja niedozwolona dla wskazanego identyfikatora lub jego typu',
      retryAfterMs: null,
    });
    expect(tekst).toMatch(/niedozwolona dla wskazanego identyfikatora/);
    expect(tekst).toMatch(/450/);
  });

  it('opis z KSeF dłuższy niż 200 znaków jest skracany', async () => {
    const { komunikatBledu } = await model();
    const tekst = komunikatBledu('status_400', 'odebranie', BIURO, { kodKsef: 400, opisKsef: 'x'.repeat(5000), retryAfterMs: null });
    expect(tekst.length).toBeLessThan(800);
  });
});

describe('kody statusu operacji (PermissionsOperationStatusResponse)', () => {
  it.each([
    [100, 'w_toku'],
    [150, 'w_toku'],
    [200, 'sukces'],
    [201, 'porazka'],
    [400, 'porazka'],
    [410, 'porazka'],
    [420, 'porazka'],
    [550, 'porazka'],
    [99, 'porazka'],
  ])('%i: %s', async (kod, wynik) => {
    const { rodzajStatusuOperacji } = await model();
    expect(rodzajStatusuOperacji(kod)).toBe(wynik);
  });
});
