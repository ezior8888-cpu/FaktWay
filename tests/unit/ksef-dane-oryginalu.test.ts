import { describe, expect, it } from 'vitest';

import {
  describeDuplicateOriginal,
  mergeDuplicateCheck,
  ORIGINAL_RECHECK_KINDS,
  originalAssignedDay,
  parseDuplicateCheck,
  parseImportGate,
  type KsefDuplicateCheck,
  type KsefOriginalImportGate,
} from '@/lib/ksef/duplicate-check';

import {
  faktflowGate,
  faktflowPreview,
  faktflowRelease,
  faktflowReviewGate,
  withoutKey,
} from './helpers/ksef-duplicate-decision-cases';

/**
 * D-A4-1b-3, PR A: dane oryginału przy nierozstrzygniętym 440
 * (`ksef_submissions.original_check`, 00144) — odczyt z bazy i panel dla
 * klienta. Klient ma widzieć FAKTY z KSeF i nigdy przycisku, którego nie ma.
 */

const K = '5260001246-20260928-0100A0B0C0D0-1A';
const check = (over: Partial<KsefDuplicateCheck> = {}): KsefDuplicateCheck => ({
  v: 1, env: 'test', checkedAt: '2026-10-04T12:00:00Z', reason: 'faktflow-original',
  sha256: 'a'.repeat(64), archivePath: `t/ksef-import/${K}.xml`, sizeBytes: 100,
  summary: { systemInfo: 'KSeF SaaS v1.0', number: 'FV/1', issueDate: '2026-09-28', buyerNip: '5252241585', buyerName: 'Klient', gross: '123.00', currency: 'PLN' },
  sameContentExceptHeader: false, ownHistory: false, acquiredAt: '2026-09-28T07:15:00.000Z', httpStatus: null, knownInvoice: null,
  recheck: null,
  ...over,
});

describe('mergeDuplicateCheck — nieudane ponowne sprawdzenie nie kasuje danych oryginału', () => {
  const full = check();
  const failedRecheck = (reason: 'download-pending' | 'download-refused' | 'storage-pending', over: Partial<KsefDuplicateCheck> = {}) =>
    check({ reason, sha256: null, archivePath: null, sizeBytes: null, summary: null, sameContentExceptHeader: null,
      ownHistory: null, acquiredAt: null, httpStatus: 503, checkedAt: '2026-10-06T10:00:00Z', ...over });

  it('pobranie nieudane → zostają dane z udanego sprawdzenia, wynik próby w recheck', () => {
    expect(mergeDuplicateCheck(full, failedRecheck('download-pending'))).toEqual({
      ...full, recheck: { reason: 'download-pending', httpStatus: 503, checkedAt: '2026-10-06T10:00:00Z' },
    });
  });

  it('nowe dane oryginału, znany numer albo inne środowisko → nowy zapis w całości', () => {
    const fresh = check({ sha256: 'b'.repeat(64), checkedAt: '2026-10-06T10:00:00Z' });
    expect(mergeDuplicateCheck(full, fresh)).toEqual({ ...fresh, recheck: null });
    const known = check({ reason: 'known-number', sha256: null, summary: null, knownInvoice: { id: 'y', internalNumber: 'FV/Y' } });
    expect(mergeDuplicateCheck(full, known)).toEqual({ ...known, recheck: null });
    const prod = failedRecheck('download-pending', { env: 'production' });
    expect(mergeDuplicateCheck(full, prod)).toEqual({ ...prod, recheck: null });
    expect(mergeDuplicateCheck(null, failedRecheck('download-refused'))).toMatchObject({ reason: 'download-refused', recheck: null });
  });
});

describe('parseDuplicateCheck', () => {
  it('zapis runnera wraca bez zmian', () => {
    const c = check({
      knownInvoice: { id: 'inna', internalNumber: 'FV/INNA/1' }, httpStatus: 403,
      recheck: { reason: 'download-refused', httpStatus: 403, checkedAt: '2026-10-06T10:00:00Z' },
    });
    expect(parseDuplicateCheck(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });

  it('brak, inna wersja albo nieznany powód → null (stary albo obcy zapis nie psuje karty)', () => {
    expect(parseDuplicateCheck(null)).toBeNull();
    expect(parseDuplicateCheck({ ...check(), v: 2 })).toBeNull();
    expect(parseDuplicateCheck({ ...check(), reason: 'cokolwiek' })).toBeNull();
    expect(parseDuplicateCheck('tekst')).toBeNull();
  });
});

describe('describeDuplicateOriginal — panel dla klienta', () => {
  it('dane oryginału: numer KSeF, data nadania, numer, data, nabywca, kwota, program', () => {
    const v = describeDuplicateOriginal('FV/1', K, check());
    expect(v.title).toBe('W KSeF jest już faktura o tym numerze');
    expect(v.rows).toEqual([
      { label: 'Numer KSeF', value: K },
      { label: 'Numer nadany w KSeF', value: '2026-09-28' },
      { label: 'Numer faktury', value: 'FV/1' },
      { label: 'Data wystawienia', value: '2026-09-28' },
      { label: 'Nabywca', value: 'Klient, NIP 5252241585' },
      { label: 'Kwota brutto', value: '123.00 PLN' },
      { label: 'Program', value: 'FaktWay' },
    ]);
    expect(v.note).toContain('Faktura FV/1');
    expect(v.note).toContain('Nie wystawiaj tej faktury ponownie');
  });

  it('bez danych (oryginału nie pobrano) — numer KSeF i data z numeru; nie udaje, że zna treść', () => {
    const v = describeDuplicateOriginal('FV/1', K, null);
    expect(v.rows).toEqual([
      { label: 'Numer KSeF', value: K },
      { label: 'Numer nadany w KSeF', value: '2026-09-28' },
    ]);
  });

  it('403: mówi, co klient ma zrobić (uprawnienie InvoiceRead), i żeby nie wystawiał ponownie', () => {
    const v = describeDuplicateOriginal('FV/1', K, check({ reason: 'download-refused', httpStatus: 403, summary: null, sha256: null }));
    expect(v.note).toContain('InvoiceRead');
    expect(v.note).toContain('Nie wystawiaj tej faktury ponownie');
  });

  it('sprawdzanie nieudane chwilowo (pobranie, magazyn, archiwum) — panel widać dopiero po wyczerpaniu ponowień, więc bez „odśwież za kilka minut”', () => {
    for (const reason of ['download-pending', 'storage-pending', 'archive-pending'] as const) {
      const note = describeDuplicateOriginal('FV/1', K, check({ reason })).note;
      expect(note).not.toMatch(/odśwież/);
      expect(note).toContain('sprawdzimy ponownie automatycznie');
      expect(note).toContain('Nie wystawiaj tej faktury ponownie');
    }
  });

  it('data nadania numeru po polsku (Europe/Warsaw), nie dzień w UTC', () => {
    const v = describeDuplicateOriginal('FV/1', K, check({ acquiredAt: '2026-09-28T22:30:00.000Z' }));
    expect(v.rows).toContainEqual({ label: 'Numer nadany w KSeF', value: '2026-09-29' });
  });

  it('oryginał to wcześniejsza wersja TEJ faktury (ownHistory) — tak to nazywamy', () => {
    const note = describeDuplicateOriginal('FV/1', K, check({ ownHistory: true })).note;
    expect(note).toContain('wcześniejsz');
    expect(note).toContain('Nie wystawiaj');
  });

  it('403: nie zakłada logowania tokenem — wskazuje też Ustawienia → KSeF', () => {
    const note = describeDuplicateOriginal('FV/1', K, check({ reason: 'download-refused', httpStatus: 403 })).note;
    expect(note).toContain('Ustawienia');
  });

  it('dane z udanego sprawdzenia mają pierwszeństwo przed nieudaną próbą (recheck)', () => {
    const v = describeDuplicateOriginal('FV/1', K, check({ recheck: { reason: 'download-pending', httpStatus: 503, checkedAt: '2026-10-06T10:00:00Z' } }));
    expect(v.rows).toContainEqual({ label: 'Kwota brutto', value: '123.00 PLN' });
    expect(v.note).not.toMatch(/odśwież/);
  });

  it('żaden komunikat nie obiecuje przycisku decyzji ani nie każe wystawiać od nowa', () => {
    for (const reason of ['known-number', 'download-refused', 'download-pending', 'storage-pending', 'archive-pending',
      'faktflow-original', 'same-content-other-program', 'no-own-file', 'archive-conflict'] as const) {
      const note = describeDuplicateOriginal('FV/1', K, check({ reason })).note;
      expect(note).not.toMatch(/kliknij|wybierz|przycisk|poprosimy/i);
      expect(note).not.toMatch(/wystaw (ją|fakturę) (ponownie|od nowa)/i);
    }
  });
});

/**
 * D-A4-1b-3 PR B: decyzja klienta przy 440. Zapis `original_check.decision`
 * (00148) wraca z odczytu; notatki karty bez „zajmujemy się” i „operator”
 * (reguła 07.10, ta sama przyczyna co notatka domyślna — reguła 3 protokołu),
 * z adresem pomocy; `known-number` ma własną notatkę „dokument {Y}” i odnośnik
 * do niego (C16).
 */
const PR_B_DOWNLOAD_REFUSED =
  'Nie mogliśmy pobrać treści tej faktury z KSeF — sprawdzimy ją ponownie automatycznie (zwykle w ciągu 2 dni); pytania: pomoc FaktWay (pomoc@faktway.pl), podaj numer faktury. Nie wystawiaj tej faktury ponownie.';
const PR_B_PENDING =
  'Nie udało się jeszcze sprawdzić treści tej faktury w KSeF — sprawdzimy ponownie automatycznie (zwykle w ciągu 2 dni). Jeśli ten komunikat zostanie dłużej, napisz do nas: pomoc@faktway.pl, podając numer faktury. Nie wystawiaj tej faktury ponownie.';
const prBDefault = (doc: string) =>
  `${doc} nie została przyjęta, bo KSeF ma już fakturę Twojej firmy o tym numerze (dane wyżej). Tej sprawy nie rozstrzygniesz jeszcze w panelu — pytania: pomoc FaktWay (pomoc@faktway.pl), podaj numer faktury. Nie wystawiaj tej faktury ponownie.`;
const prBOwnHistory = (doc: string) =>
  `${doc} nie została przyjęta, bo KSeF ma już wcześniejszą wersję tej faktury wysłaną z FaktWay (dane wyżej). Tej sprawy nie rozstrzygniesz jeszcze w panelu — pytania: pomoc FaktWay (pomoc@faktway.pl), podaj numer faktury. Nie wystawiaj tej faktury ponownie.`;
const prBKnownNumber = (y: string, nr: string) =>
  `W FaktWay numer KSeF ${K} ma już dokument ${y} — te dane się nie zgadzają i musimy je wyjaśnić, zanim zdecydujesz, czym jest ten dokument. Napisz do nas: pomoc@faktway.pl, podając numer ${nr}. Nie wystawiaj tej faktury ponownie.`;

describe('U2a: parseDuplicateCheck — decyzja klienta (00148)', () => {
  it('zapisana decyzja wraca jako {choice, via, at}; zniekształcona — bez klucza', () => {
    const decided = { ...check(), decision: { choice: 'other_sale', via: 'client', at: '2026-10-05T10:00:00.000Z', reason: 'faktflow-original', env: 'test' } };
    expect(parseDuplicateCheck(JSON.parse(JSON.stringify(decided)))?.decision)
      .toEqual({ choice: 'other_sale', via: 'client', at: '2026-10-05T10:00:00.000Z' });
    const byOperator = { ...check(), decision: { choice: 'same_sale', via: 'operator', at: '2026-10-05T11:00:00.000Z' } };
    expect(parseDuplicateCheck(byOperator)?.decision).toEqual({ choice: 'same_sale', via: 'operator', at: '2026-10-05T11:00:00.000Z' });
    for (const decision of [{ choice: 'cokolwiek', via: 'client', at: '2026-10-05T10:00:00.000Z' }, { choice: 'same_sale', via: 'ktoś', at: 'x' }, 'other_sale', null]) {
      expect(parseDuplicateCheck({ ...check(), decision }), JSON.stringify(decision)).not.toHaveProperty('decision');
    }
  });

  it('strażnik: bez klucza decision zapis wraca bez niego (odczyt PR A bez zmian)', () => {
    expect(parseDuplicateCheck(JSON.parse(JSON.stringify(check())))).not.toHaveProperty('decision');
  });
});

describe('U2b–U2d: notatki karty bez „zajmujemy się” i operatora, z adresem pomocy; known-number z odnośnikiem (C16)', () => {
  const NOTE_CASES: Array<[string, Partial<KsefDuplicateCheck>]> = [
    ['download-refused (nie 403)', { reason: 'download-refused', httpStatus: 404, summary: null, sha256: null }],
    ['download-pending', { reason: 'download-pending' }],
    ['storage-pending', { reason: 'storage-pending' }],
    ['archive-pending', { reason: 'archive-pending' }],
    ['domyślna (faktflow-original)', {}],
    ['domyślna (no-own-file)', { reason: 'no-own-file', summary: { ...check().summary!, systemInfo: 'Inny Program' } }],
    ['wcześniejsza wersja (ownHistory)', { ownHistory: true }],
    ['known-number', { reason: 'known-number', knownInvoice: { id: 'y', internalNumber: 'FV/Y' } }],
  ];

  it.each(NOTE_CASES)('U2b: %s — bez „operator” i „zajmujemy się”', (_name, over) => {
    const note = describeDuplicateOriginal('FV/1', K, check(over)).note;
    expect(note).not.toMatch(/operator/i);
    expect(note).not.toMatch(/zajmujemy się/i);
  });

  it('U2c: notatka domyślna i pozostałe — adres pomocy, tekst słowo w słowo', () => {
    expect(describeDuplicateOriginal('FV/1', K, check()).note).toBe(prBDefault('Faktura FV/1'));
    expect(describeDuplicateOriginal(null, K, check({ reason: 'no-own-file' })).note).toBe(prBDefault('Ta faktura'));
    expect(describeDuplicateOriginal('FV/1', K, check()).note).toContain('pomoc@faktway.pl');
    expect(describeDuplicateOriginal('FV/1', K, check({ ownHistory: true })).note).toBe(prBOwnHistory('Faktura FV/1'));
    expect(describeDuplicateOriginal('FV/1', K, check({ reason: 'download-refused', httpStatus: 404 })).note).toBe(PR_B_DOWNLOAD_REFUSED);
    for (const reason of ['download-pending', 'storage-pending', 'archive-pending'] as const) {
      expect(describeDuplicateOriginal('FV/1', K, check({ reason })).note, reason).toBe(PR_B_PENDING);
    }
  });

  it('U2d: known-number — „dokument {Y}” i odnośnik „Zobacz dokument {Y}”; bez Y — „bez numeru” i bez odnośnika', () => {
    const v = describeDuplicateOriginal('FV/1', K, check({ reason: 'known-number', knownInvoice: { id: 'y', internalNumber: 'FV/Y' } }));
    expect(v.note).toBe(prBKnownNumber('FV/Y', 'FV/1'));
    expect(v.note).toContain('dokument FV/Y');
    expect(v.link).toEqual({ href: '/invoices/y', label: 'Zobacz dokument FV/Y' });
    const withoutNumber = describeDuplicateOriginal('FV/1', K, check({ reason: 'known-number', knownInvoice: { id: 'y', internalNumber: null } }));
    expect(withoutNumber.note).toBe(prBKnownNumber('bez numeru', 'FV/1'));
    expect(withoutNumber.link).toEqual({ href: '/invoices/y', label: 'Zobacz dokument bez numeru' });
    const noKnown = describeDuplicateOriginal('FV/1', K, check({ reason: 'known-number', knownInvoice: null }));
    expect(noKnown.link).toBeNull();
  });

  it('U2d: każdy inny powód (i brak zapisu) — link: null', () => {
    for (const reason of ['download-refused', 'download-pending', 'storage-pending', 'archive-pending',
      'faktflow-original', 'same-content-other-program', 'no-own-file', 'archive-conflict'] as const) {
      // knownInvoice przy innym powodzie nie daje odnośnika (odnośnik tylko przy known-number).
      const v = describeDuplicateOriginal('FV/1', K, check({ reason, knownInvoice: { id: 'y', internalNumber: 'FV/Y' } }));
      expect(v.link, reason).toBeNull();
    }
    expect(describeDuplicateOriginal('FV/1', K, null).link).toBeNull();
  });

  it('strażnik: notatka 403 bez zmian (InvoiceRead, Ustawienia → KSeF)', () => {
    const note = describeDuplicateOriginal('FV/1', K, check({ reason: 'download-refused', httpStatus: 403, summary: null, sha256: null })).note;
    expect(note).toBe(
      'Nie mogliśmy pobrać treści tej faktury z KSeF — dane logowania KSeF w FaktWay nie mają uprawnienia do odczytu ' +
      'faktur (InvoiceRead). Sprawdź uprawnienia w Aplikacji Podatnika KSeF albo podłącz KSeF ponownie w Ustawieniach → KSeF. ' +
      'Nie wystawiaj tej faktury ponownie.',
    );
  });
});

/**
 * D-A4-1b-3 PR C (00149, spec v3 5.1 punkt 4, INV-25, INV-26): brama pochodzenia
 * oryginału (`original_check.importGate`) i trwały znacznik „sprawdź ponownie”
 * (`recheckNeeded`) przy odczycie z bazy, dzień nadania numeru oraz zachowanie
 * oddania decyzji (`release`) przy kolejnym sprawdzeniu. Czyste funkcje
 * `lib/ksef/duplicate-check.ts`, bez bazy i KSeF.
 */
const asGate = (gate: Record<string, unknown>): KsefOriginalImportGate => gate as unknown as KsefOriginalImportGate;
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('U2e (PR C): parseImportGate — sprawdza to, co czyta oferta (lustro ksef_duplicate_gate_ok)', () => {
  const releaseGate = faktflowReviewGate(['rates'], { release: faktflowRelease() });

  it('poprawna brama wraca bez zmian: importable, review i review z oddaniem (release w całości, z aktorem i notatką)', () => {
    for (const gate of [faktflowGate(), faktflowReviewGate(['rates', 'amounts']), releaseGate]) {
      expect(parseImportGate(wire(gate)), JSON.stringify(gate.kind)).toEqual(gate);
    }
  });

  it('podgląd pliku zostaje bez przebudowy (także o nieznanym kształcie albo null); rules informacyjnie, dowolna liczba', () => {
    const odd = { period: '10.2026', dziwny: [1, 2, { a: 1 }] };
    expect(parseImportGate(wire(faktflowGate({ preview: odd })))?.preview).toEqual(odd);
    expect(parseImportGate(wire(faktflowReviewGate(['parse'], { preview: null })))?.preview).toBeNull();
    expect(parseImportGate(wire(faktflowGate({ rules: 7 })))?.rules).toBe(7);
  });

  it.each([
    ['null', null],
    ['napis', 'importable'],
    ['tablica', []],
    ['wersja 2', faktflowGate({ v: 2 })],
    ['wersja napisem', faktflowGate({ v: '1' })],
    ['bez rules', withoutKey(faktflowGate(), 'rules')],
    ['rules napisem', faktflowGate({ rules: '1' })],
    ['kind nieznany', faktflowGate({ kind: 'cokolwiek' })],
    ['bez kind', withoutKey(faktflowGate(), 'kind')],
    ['problems nie tablicą', faktflowGate({ problems: 'rates' })],
    ['bez problems', withoutKey(faktflowGate(), 'problems')],
    ['element problems nie jest napisem', faktflowReviewGate([], { problems: ['rates', 1] })],
    ['importable z problemem', faktflowGate({ problems: ['rates'] })],
    ['review bez problemów', faktflowReviewGate([])],
  ])('zły kształt (%s) → null, czyli brak klucza importGate = recheck-needed', (_name, gate) => {
    // Ta sama funkcja musi przyjąć poprawną bramę — wynik `null` nie może być odpowiedzią na wszystko.
    expect(parseImportGate(wire(faktflowGate()))).not.toBeNull();
    expect(parseImportGate(wire(gate))).toBeNull();
  });

  it.each([
    ['via client', { via: 'client' }],
    ['via Operator wielką literą', { via: 'Operator' }],
    ['at pustym napisem', { at: '' }],
    ['at liczbą', { at: 1760000000 }],
    ['actorUserId liczbą', { actorUserId: 7 }],
    ['note liczbą', { note: 7 }],
  ])('release o złym kształcie (%s): klucz release pominięty, reszta bramy zostaje', (_name, over) => {
    expect(parseImportGate(wire(releaseGate))?.release).toEqual(faktflowRelease());
    const gate = faktflowReviewGate(['rates'], { release: faktflowRelease(over) });
    expect(parseImportGate(wire(gate))).toEqual(withoutKey(gate, 'release'));
  });

  // M5: SQL (`ksef_duplicate_original_offer`, 4.4) sprawdza przy `release.at` tylko typ (napis), nie format daty.
  // Reguła TS: `parseImportGate` zachowuje oddanie, którego `at` jest DOWOLNYM niepustym napisem — inaczej po
  // ponownym sprawdzeniu (mergeDuplicateCheck) oferta TS (`released`) rozjechałaby się z SQL (też `released`).
  it.each(['nie data', 'wczoraj po południu', '2026-13-45', '08.10.2026'])('release.at „%s” (napis, nie data): release ZOSTAJE w bramie', (at) => {
    const release = faktflowRelease({ at });
    const gate = faktflowReviewGate(['rates'], { release });
    expect(parseImportGate(wire(releaseGate))?.release).toEqual(faktflowRelease());
    expect(parseImportGate(wire(gate))).toEqual(gate);
    expect(parseImportGate(wire(gate))?.release).toEqual(release);
  });

  it.each([
    ['null', null],
    ['tablica', []],
    ['napis', 'operator'],
    ['pusty obiekt', {}],
  ])('release %s: klucz release pominięty, brama poprawna', (_name, release) => {
    expect(parseImportGate(wire(releaseGate))?.release).toEqual(faktflowRelease());
    const gate = faktflowReviewGate(['rates'], { release });
    expect(parseImportGate(wire(gate))).toEqual(withoutKey(gate, 'release'));
  });

  it('release z aktorem i notatką null (oddanie bez danych aktora) jest poprawne', () => {
    const release = faktflowRelease({ actorUserId: null, note: null });
    expect(parseImportGate(wire(faktflowReviewGate(['rates'], { release })))?.release).toEqual(release);
  });
});

describe('U2f (PR C): parseDuplicateCheck — importGate i recheckNeeded wracają z zapisu tylko w poprawnym kształcie', () => {
  const gateFull = faktflowReviewGate(['rates', 'amounts'], { release: faktflowRelease() });
  const flagged = { kind: 'gate-drift', at: '2026-10-09T08:00:00.000Z' };

  it('zapis runnera z bramą, oddaniem i znacznikiem wraca bez zmian', () => {
    const c = { ...check(), importGate: asGate(gateFull), recheckNeeded: flagged };
    expect(parseDuplicateCheck(wire(c))).toEqual(c);
    const importable = { ...check(), importGate: asGate(faktflowGate()) };
    expect(parseDuplicateCheck(wire(importable))).toEqual(importable);
  });

  it.each(ORIGINAL_RECHECK_KINDS)('recheckNeeded z rodzajem %s wraca', (kind) => {
    const c = { ...check(), recheckNeeded: { kind, at: '2026-10-09T08:00:00.000Z' } };
    expect(parseDuplicateCheck(wire(c))).toEqual(c);
  });

  it('zły kształt bramy albo znacznika → klucz pominięty (brak bramy = recheck-needed w blokadzie)', () => {
    // Poprawny zapis przechodzi — dopiero wtedy odrzucenia mają sens.
    expect(parseDuplicateCheck(wire({ ...check(), importGate: gateFull, recheckNeeded: flagged }))).toHaveProperty('importGate');
    for (const importGate of [null, 'importable', faktflowGate({ v: 2 }), faktflowGate({ kind: 'cokolwiek' }), faktflowGate({ problems: ['rates'] }), faktflowReviewGate([])]) {
      expect(parseDuplicateCheck(wire({ ...check(), importGate })), JSON.stringify(importGate)).not.toHaveProperty('importGate');
    }
    for (const recheckNeeded of [null, 'gate-drift', [], { kind: 'cokolwiek', at: flagged.at }, { kind: 'gate-drift' }, { kind: 'gate-drift', at: 5 }]) {
      expect(parseDuplicateCheck(wire({ ...check(), recheckNeeded })), JSON.stringify(recheckNeeded)).not.toHaveProperty('recheckNeeded');
    }
  });

  it('zapis bez bramy (sprzed 00149) wraca bez klucza importGate i recheckNeeded', () => {
    expect(parseDuplicateCheck(wire({ ...check(), importGate: gateFull }))).toHaveProperty('importGate');
    const old = parseDuplicateCheck(wire(check()));
    expect(old).not.toHaveProperty('importGate');
    expect(old).not.toHaveProperty('recheckNeeded');
  });
});

describe('U2g (PR C): originalAssignedDay — dzień nadania numeru KSeF oryginałowi (Europe/Warsaw)', () => {
  it('acquiredAt w polskim dniu, nie w UTC; bez niego data z numeru KSeF; bez obu null', () => {
    expect(originalAssignedDay({ acquiredAt: '2026-09-28T22:30:00.000Z' }, K)).toBe('2026-09-29');
    expect(originalAssignedDay({ acquiredAt: '2026-12-31T23:30:00.000Z' }, K)).toBe('2027-01-01');
    expect(originalAssignedDay({ acquiredAt: '2026-09-28T07:15:00.000Z' }, K)).toBe('2026-09-28');
    expect(originalAssignedDay({ acquiredAt: null }, K)).toBe('2026-09-28');
    expect(originalAssignedDay(null, K)).toBe('2026-09-28');
    expect(originalAssignedDay({ acquiredAt: 'nie data' }, K)).toBe('2026-09-28');
    expect(originalAssignedDay({ acquiredAt: null }, 'KSEF-BEZ-DATY')).toBeNull();
    expect(originalAssignedDay(null, 'KSEF-BEZ-DATY')).toBeNull();
  });

  it('ten sam dzień co wiersz „Numer nadany w KSeF” karty (describeDuplicateOriginal)', () => {
    for (const acquiredAt of ['2026-09-28T22:30:00.000Z', null, '2026-12-31T23:30:00.000Z']) {
      const row = describeDuplicateOriginal('FV/1', K, check({ acquiredAt })).rows.find((r) => r.label === 'Numer nadany w KSeF');
      expect(originalAssignedDay({ acquiredAt }, K)).toBe(row?.value);
    }
  });
});

describe('U2h (PR C): mergeDuplicateCheck — oddanie decyzji (release) przechodzi tylko przy tym samym pliku i tej samej ocenie review (INV-26); recheckNeeded nigdy', () => {
  const release = faktflowRelease();
  const reviewGate = (problems: string[], over: Record<string, unknown> = {}) => asGate(faktflowReviewGate(problems, over));
  const released = (over: Partial<KsefDuplicateCheck> = {}) =>
    check({ importGate: reviewGate(['rates', 'amounts'], { release }), recheckNeeded: { kind: 'gate-drift', at: '2026-10-09T08:00:00.000Z' }, ...over });
  /** Nowy werdykt: ten sam plik (sha256, env), nowe `checkedAt`, nowa ocena — z innym podglądem i wersją reguł. */
  const fresh = (over: Partial<KsefDuplicateCheck> = {}) =>
    check({ checkedAt: '2026-10-11T12:00:00Z', importGate: reviewGate(['amounts', 'rates'], { rules: 2, preview: faktflowPreview({ lineCount: 5 }) }), ...over });

  it('ten sam plik, środowisko i ta sama ocena review (problems jako zbiór) → release z poprzedniego zapisu; reszta bramy i checkedAt z nowego; recheckNeeded znika', () => {
    const merged = mergeDuplicateCheck(released(), fresh());
    expect(merged.importGate).toEqual({ ...fresh().importGate, release });
    expect(merged.checkedAt).toBe('2026-10-11T12:00:00Z');
    expect(merged).not.toHaveProperty('recheckNeeded');
    expect(merged.recheck).toBeNull();
  });

  it('inny plik, środowisko, ocena albo powód → przegląd od nowa, bez release', () => {
    // Warunek dodatni — bez niego brak release poniżej nic nie dowodzi.
    expect(mergeDuplicateCheck(released(), fresh()).importGate?.release).toEqual(release);
    const cases: Array<[string, KsefDuplicateCheck, KsefDuplicateCheck]> = [
      ['inny SHA-256', released(), fresh({ sha256: 'b'.repeat(64) })],
      ['inne środowisko', released(), fresh({ env: 'production' })],
      ['inne problemy (zbiór)', released(), fresh({ importGate: reviewGate(['amounts']) })],
      ['dodatkowy problem', released(), fresh({ importGate: reviewGate(['rates', 'amounts', 'totals']) })],
      ['nowa ocena importable', released(), fresh({ importGate: asGate(faktflowGate()) })],
      ['poprzednia brama w złym kształcie', released({ importGate: asGate(faktflowReviewGate(['rates', 'amounts'], { v: 2, release })) }), fresh()],
      ['poprzednia brama bez release', released({ importGate: reviewGate(['rates', 'amounts']) }), fresh()],
      ['nowy zapis bez bramy', released(), check({ checkedAt: '2026-10-11T12:00:00Z' })],
    ];
    for (const [name, previous, next] of cases) {
      const merged = mergeDuplicateCheck(previous, next);
      expect(merged.importGate?.release, name).toBeUndefined();
      expect(merged, name).not.toHaveProperty('recheckNeeded');
    }
  });

  it('powód nowego zapisu inny niż faktflow-original (known-number) — zapis w całości, bez bramy poprzedniego', () => {
    // Warunek dodatni: przy tym samym powodzie release przechodzi (inaczej brak bramy poniżej nic nie dowodzi).
    expect(mergeDuplicateCheck(released(), fresh()).importGate?.release).toEqual(release);
    const known = check({ reason: 'known-number', knownInvoice: { id: 'y', internalNumber: 'FV/Y' }, checkedAt: '2026-10-11T12:00:00Z' });
    const merged = mergeDuplicateCheck(released(), known);
    expect(merged).toEqual({ ...known, recheck: null });
  });
});

describe('U2i (PR C, INV-16): mergeDuplicateCheck — znana data nadania K zostaje przy kolejnym werdykcie tego samego pliku (INV-16)', () => {
  const ACQ = '2026-09-28T07:15:00.000Z';
  const previous = (over: Partial<KsefDuplicateCheck> = {}) =>
    check({ acquiredAt: ACQ, importGate: asGate(faktflowReviewGate(['rates'], { release: faktflowRelease() })), ...over });
  /** Kolejny werdykt: pytanie o datę w KSeF nie powiodło się (429/5xx), więc `acquiredAt` jest `null`. */
  const next = (over: Partial<KsefDuplicateCheck> = {}) =>
    check({ checkedAt: '2026-10-11T12:00:00Z', acquiredAt: null, importGate: asGate(faktflowReviewGate(['rates'])), ...over });

  it('(a) ten sam plik i środowisko, nowa data nieznana → data z poprzedniego zapisu; znacznik „sprawdź ponownie” nadal znika', () => {
    const merged = mergeDuplicateCheck(previous({ recheckNeeded: { kind: 'gate-drift', at: '2026-10-09T08:00:00.000Z' } }), next());
    expect(merged.acquiredAt).toBe(ACQ);
    expect(merged.checkedAt).toBe('2026-10-11T12:00:00Z');
    expect(merged).not.toHaveProperty('recheckNeeded');
    expect(merged.recheck).toBeNull();
  });

  it('(b) inny plik albo inne środowisko → data zostaje nieznana (to nie jest ten sam K)', () => {
    // Warunek dodatni: przy tym samym pliku data wraca — inaczej `null` poniżej nic nie dowodzi.
    expect(mergeDuplicateCheck(previous(), next()).acquiredAt).toBe(ACQ);
    expect(mergeDuplicateCheck(previous(), next({ sha256: 'b'.repeat(64) })).acquiredAt).toBeNull();
    expect(mergeDuplicateCheck(previous(), next({ env: 'production' })).acquiredAt).toBeNull();
    expect(mergeDuplicateCheck(previous({ sha256: null }), next({ sha256: null })).acquiredAt).toBeNull();
    expect(mergeDuplicateCheck(previous({ acquiredAt: null }), next()).acquiredAt).toBeNull();
  });

  it('(c) nowy werdykt ma własną datę → wygrywa nowa', () => {
    const NEW = '2026-09-28T07:16:00.000Z';
    expect(mergeDuplicateCheck(previous(), next({ acquiredAt: NEW })).acquiredAt).toBe(NEW);
  });
});
