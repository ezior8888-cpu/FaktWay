import { describe, expect, it } from 'vitest';

import {
  bledyMapy,
  importyPliku,
  klasyfikujPlik,
  klasyfikujZmiane,
  martweWzorce,
  pasujeDoWzorca,
  plikiZDiffu,
  porownajMapy,
  poziomZeSciezki,
  przygotujMape,
  sygnalyNazwy,
  sygnalyTresci,
  wczytajMape,
  wyzszyPoziom,
  znormalizowanaNazwa,
} from '@/scripts/filtr/mapa.mjs';

/**
 * Klasyfikator mapy ryzyka (żelazny filtr F1, plan B3). Mała mapa w teście
 * sprawdza zasady; prawdziwa mapa ma osobny test pełnego skanu (mapa.test.ts).
 */

function surowaMapa() {
  return {
    wersja: 1,
    kod: {
      katalogi: ['lib/', 'app/', 'components/', 'supabase/migrations/', 'proxy.ts'],
      rozszerzenia: ['.ts', '.tsx', '.sql', '.md'],
      pomijane: ['**/*.test.ts'],
    },
    obszary: [
      { id: 'silniki', poziom: 'R1', opis: 'Silniki obliczeń podatków.', sciezki: ['lib/podatki/**'] },
      { id: 'szacunki', poziom: 'R2', opis: 'Szacunki na pulpicie.', sciezki: ['lib/pulpit/{a,b}.ts', 'lib/podatki/szacunek.ts'] },
      { id: 'ekrany', poziom: 'R3', opis: 'Ekrany i komponenty.', sciezki: ['app/**/*.tsx', 'components/**/*.tsx'] },
      { id: 'sql', poziom: 'R1', opis: 'Funkcje SQL zapłat.', sciezki: ['supabase/migrations/{00012,00014}_*.sql'] },
    ],
    wylaczenia: [{ sciezki: ['lib/auth/**'], powod: 'Logowanie i sesje, bez obliczeń prawnych.' }],
    sygnaly: {
      tresc: [
        { id: 'vat', wzorzec: '(?<![A-Za-z])(?:VAT|[Vv]at)|(?<=[a-z])Vat' },
        { id: 'termin', wzorzec: '(?<![A-Za-z])[Tt]ermin(?!al|at)' },
        { id: 'kurs', wzorzec: '(?<![A-Za-z])[Kk]urs(?!or)' },
        { id: 'pit', wzorzec: '(?<![A-Za-z])(?:PIT|[Pp]it)(?![a-z])|(?<=[a-z])Pit(?![a-z])' },
        {
          id: 'tabela-prawna',
          wzorzec: "\\.from\\(\\s*['\"](?:invoices|expenses)['\"]|(?:FROM|JOIN|UPDATE)\\s+(?:public\\.)?invoices\\b",
        },
        { id: 'usuwanie', wzorzec: '\\.delete\\(\\s*[){]|DELETE\\s+FROM' },
        {
          id: 'tresci-prawne',
          wzorzec:
            'doradztw|(?<![A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż])[Kk]ar(?:a|y|ę|ą|om|ami|ach)(?![A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż])',
          flagi: 'i',
        },
      ],
      nazwy: [
        { id: 'podatki', wzorzec: '(?:^|-)(?:vat|jpk|tax)|(?:^|-)pit(?:-|$)' },
        { id: 'dokumenty', wzorzec: '(?:^|-)(?:self-invoice|issue-date)(?:-|$)' },
        { id: 'terminy', wzorzec: '(?:^|-)(?:deadline|termin(?!al|at))' },
      ],
    },
  };
}

const mapa = przygotujMape(surowaMapa());

describe('wzorce ścieżek', () => {
  it.each([
    ['lib/podatki/**', 'lib/podatki/zus.ts', true],
    ['lib/podatki/**', 'lib/podatki/a/b/c.ts', true],
    ['lib/podatki/**', 'lib/podatkiX/zus.ts', false],
    ['app/**/*.tsx', 'app/page.tsx', true],
    ['app/**/*.tsx', 'app/(dashboard)/invoices/[id]/page.tsx', true],
    ['app/**/*.tsx', 'app/(dashboard)/invoices/actions.ts', false],
    ['lib/pulpit/{a,b}.ts', 'lib/pulpit/b.ts', true],
    ['lib/pulpit/{a,b}.ts', 'lib/pulpit/c.ts', false],
    ['lib/ksef/duplicate-*.ts', 'lib/ksef/duplicate-check.ts', true],
    ['lib/ksef/duplicate-*.ts', 'lib/ksef/sub/duplicate-check.ts', false],
    ['supabase/migrations/000??_*.sql', 'supabase/migrations/00012_x.sql', true],
    ['supabase/migrations/000??_*.sql', 'supabase/migrations/00174_x.sql', false],
    ['scripts/ops/zwolnij.{sh,sql}', 'scripts/ops/zwolnij.sql', true],
    ['app/(dashboard)/reports/{vat,ewidencja}/**', 'app/(dashboard)/reports/vat/page.tsx', true],
    ['app/(dashboard)/reports/{vat,ewidencja}/**', 'app/dashboard/reports/vat/page.tsx', false],
    ['app/accountant/[token]/download/**', 'app/accountant/[token]/download/[id]/route.ts', true],
    ['lib/{a,b/{c,d}}.ts', 'lib/b/d.ts', true],
  ])('%s ~ %s → %s', (wzorzec, plik, oczekiwane) => {
    expect(pasujeDoWzorca(wzorzec, plik)).toBe(oczekiwane);
  });

  it('niezamknięty nawias to błąd mapy, nie cicha niezgodność', () => {
    const zla = surowaMapa();
    zla.obszary[0].sciezki = ['lib/{a,b.ts'];
    expect(bledyMapy(zla).join('\n')).toMatch(/Niezamknięty nawias/);
  });
});

describe('poziomy', () => {
  it('wyższy poziom wygrywa, R1 jest najwyższy', () => {
    expect(wyzszyPoziom('R3', 'R1')).toBe('R1');
    expect(wyzszyPoziom('R2', 'R3')).toBe('R2');
    expect(wyzszyPoziom('R0', 'R3')).toBe('R3');
    expect(() => wyzszyPoziom('R4', 'R1')).toThrow(/Nieznany poziom/);
  });
});

describe('budowa mapy', () => {
  it('poprawna mapa nie ma błędów', () => {
    expect(bledyMapy(surowaMapa())).toEqual([]);
  });

  it.each([
    ['powtórzone id obszaru', (m: ReturnType<typeof surowaMapa>) => m.obszary.push({ ...m.obszary[0] }), /powtórzone id/],
    ['obszar R0', (m: ReturnType<typeof surowaMapa>) => (m.obszary[1].poziom = 'R0'), /nie może mieć poziomu R0/],
    ['nieznany poziom', (m: ReturnType<typeof surowaMapa>) => (m.obszary[1].poziom = 'R5'), /poziom musi być/],
    ['brak opisu', (m: ReturnType<typeof surowaMapa>) => (m.obszary[1].opis = ''), /brak opisu/],
    ['pusta lista ścieżek', (m: ReturnType<typeof surowaMapa>) => (m.obszary[1].sciezki = []), /brak ścieżek/],
    ['ścieżka bezwzględna', (m: ReturnType<typeof surowaMapa>) => (m.obszary[1].sciezki = ['/lib/x.ts']), /względny/],
    ['wyłączenie bez powodu', (m: ReturnType<typeof surowaMapa>) => (m.wylaczenia[0].powod = 'bo'), /wymaga powodu/],
    ['zły wzorzec sygnału', (m: ReturnType<typeof surowaMapa>) => (m.sygnaly.tresc[0].wzorzec = '(a'), /zły wzorzec/],
    ['zła wersja', (m: ReturnType<typeof surowaMapa>) => (m.wersja = 2), /wersja/],
  ])('%s', (_opis, zepsuj, blad) => {
    const m = surowaMapa();
    zepsuj(m);
    expect(bledyMapy(m).join('\n')).toMatch(blad);
    expect(() => przygotujMape(m)).toThrow(/Mapa ryzyka jest niepoprawna/);
  });
});

describe('sygnały w treści', () => {
  it.each([
    ['const stawkaVat = 23;', ['vat']],
    ['const totalVat = 1;', ['vat']],
    ['// VAT należny', ['vat']],
    ['const vat_rate = 0.23;', ['vat']],
    ['private activate() {}', []],
    ['termin płatności', ['termin']],
    ['w terminie', ['termin']],
    ['terminal.write(); determine(); terminate();', []],
    ['kurs NBP z dnia poprzedniego', ['kurs']],
    ['kursor myszy', []],
    ['zaliczka na PIT', ['pit']],
    ['pitch and spit', []],
    ["await supabase.from('invoices').select()", ['tabela-prawna']],
    ['UPDATE public.invoices SET paid = true', ['tabela-prawna']],
    ["<Link href='/invoices'>Faktury</Link>", []],
    ["await supabase.from('x').delete()", ['usuwanie']],
    ['cache.delete(klucz)', []],
    ['grozi kara umowna', ['tresci-prawne']],
    ['karta płatnicza', []],
  ])('%s', (tekst, oczekiwane) => {
    expect(sygnalyTresci(mapa, tekst)).toEqual(oczekiwane);
  });
});

describe('sygnały w nazwie pliku', () => {
  it.each([
    ['lib/x/invoiceVatSummary.ts', 'invoice-vat-summary-ts', ['nazwa:podatki']],
    ['lib/x/private-route.tsx', 'private-route-tsx', []],
    ['lib/x/terminal.ts', 'terminal-ts', []],
    ['lib/x/terminy.ts', 'terminy-ts', ['nazwa:terminy']],
    ['lib/x/self-invoice-payment.ts', 'self-invoice-payment-ts', ['nazwa:dokumenty']],
    ['lib/x/pit.ts', 'pit-ts', ['nazwa:podatki']],
    ['lib/x/pitch.ts', 'pitch-ts', []],
    ['lib/x/tax_profile.ts', 'tax-profile-ts', ['nazwa:podatki']],
  ])('%s', (plik, nazwa, oczekiwane) => {
    expect(znormalizowanaNazwa(plik)).toBe(nazwa);
    expect(sygnalyNazwy(mapa, plik)).toEqual(oczekiwane);
  });
});

describe('klasyfikacja pliku', () => {
  it('plik w obszarze dziedziczy poziom; kilka obszarów daje najwyższy', () => {
    expect(klasyfikujPlik(mapa, 'lib/podatki/nowy.ts')).toMatchObject({ status: 'obszar', poziom: 'R1', obszary: ['silniki'] });
    expect(klasyfikujPlik(mapa, 'lib/podatki/szacunek.ts')).toMatchObject({
      poziom: 'R1',
      obszary: ['silniki', 'szacunki'],
    });
    expect(klasyfikujPlik(mapa, 'lib/pulpit/a.ts')).toMatchObject({ poziom: 'R2' });
  });

  it('obszar wygrywa z wyłączeniem i z regułą „pomijane”', () => {
    expect(klasyfikujPlik(mapa, 'lib/podatki/zus.test.ts')).toMatchObject({ status: 'obszar', poziom: 'R1' });
  });

  it('plik z sygnałem poza mapą jest niesklasyfikowany i liczy się jak R1', () => {
    const wynik = klasyfikujPlik(mapa, 'lib/nowe/rozliczenie.ts', { tresc: 'const stawkaVat = 23;' });
    expect(wynik).toMatchObject({ status: 'niesklasyfikowany', poziom: 'R1', sygnaly: ['vat'] });
  });

  it('sygnał z nazwy pliku wystarcza, nawet bez treści', () => {
    expect(klasyfikujPlik(mapa, 'lib/nowe/vat-limit.ts')).toMatchObject({
      status: 'niesklasyfikowany',
      sygnaly: ['nazwa:podatki'],
    });
  });

  it('import pliku R1 to sygnał', () => {
    expect(klasyfikujPlik(mapa, 'lib/nowe/x.ts', { importyR1: ['lib/podatki/zus.ts'] })).toMatchObject({
      status: 'niesklasyfikowany',
      sygnaly: ['import-r1:lib/podatki/zus.ts'],
    });
  });

  it('plik w wyłączeniu ma R0 i powód, mimo sygnałów', () => {
    expect(klasyfikujPlik(mapa, 'lib/auth/mfa.ts', { tresc: 'VAT' })).toMatchObject({
      status: 'wylaczony',
      poziom: 'R0',
      powod: 'Logowanie i sesje, bez obliczeń prawnych.',
    });
  });

  it('plik kodu bez sygnałów ma R0; plik spoza kodu nie jest oceniany', () => {
    expect(klasyfikujPlik(mapa, 'lib/ui/kolor.ts', { tresc: 'export const a = 1;' })).toMatchObject({
      status: 'bez-sygnalu',
      poziom: 'R0',
    });
    expect(klasyfikujPlik(mapa, 'docs/notatka.md', { tresc: 'VAT' })).toMatchObject({ status: 'poza-kodem' });
    expect(klasyfikujPlik(mapa, 'lib/x/zus.test.ts', { tresc: 'VAT' })).toMatchObject({ status: 'poza-kodem' });
    expect(klasyfikujPlik(mapa, 'proxy.ts', { tresc: 'VAT' })).toMatchObject({ status: 'niesklasyfikowany' });
  });

  it('nowa migracja spoza listy nie dziedziczy poziomu; z sygnałem trzeba ją rozstrzygnąć', () => {
    expect(klasyfikujPlik(mapa, 'supabase/migrations/00012_platnosci.sql')).toMatchObject({ poziom: 'R1' });
    expect(
      klasyfikujPlik(mapa, 'supabase/migrations/00174_nowa.sql', { tresc: 'UPDATE invoices SET x = 1;' }),
    ).toMatchObject({ status: 'niesklasyfikowany' });
  });

  it('poziom zmiany to najwyższy poziom pliku', () => {
    const wynik = klasyfikujZmiane(mapa, [
      { plik: 'app/page.tsx' },
      { plik: 'lib/pulpit/b.ts' },
      { plik: 'docs/x.md' },
    ]);
    expect(wynik.poziom).toBe('R2');
    expect(wynik.niesklasyfikowane).toEqual([]);
    expect(klasyfikujZmiane(mapa, [{ plik: 'lib/nowe/vat.ts' }]).poziom).toBe('R1');
    expect(klasyfikujZmiane(mapa, []).poziom).toBe('R0');
  });

  it('poziom ze ścieżki (do importów) nie zgaduje z treści', () => {
    expect(poziomZeSciezki(mapa, 'lib/podatki/zus.ts')).toBe('R1');
    expect(poziomZeSciezki(mapa, 'lib/nowe/vat.ts')).toBe('R0');
  });
});

describe('importy', () => {
  const pliki = new Set(['lib/podatki/zus.ts', 'lib/podatki/index.ts', 'components/x/y.tsx', 'lib/a/b.ts']);
  const istnieje = (p: string) => pliki.has(p);

  it('rozwiązuje alias @/, ścieżki względne, katalog z index i import dynamiczny', () => {
    const tekst = [
      "import { zus } from '@/lib/podatki/zus';",
      "import x from '../../components/x/y';",
      "const m = await import('@/lib/podatki');",
      "export { b } from './b';",
      "import React from 'react';",
      "import { nic } from '@/lib/nie-ma';",
    ].join('\n');
    expect(importyPliku('lib/a/c.ts', tekst, istnieje).sort()).toEqual(
      ['components/x/y.tsx', 'lib/a/b.ts', 'lib/podatki/index.ts', 'lib/podatki/zus.ts'].sort(),
    );
  });
});

describe('diff', () => {
  it('dodane linie, nowy plik, usunięty plik i zmiana nazwy', () => {
    const diff = [
      'diff --git a/lib/a.ts b/lib/a.ts',
      'index 1..2 100644',
      '--- a/lib/a.ts',
      '+++ b/lib/a.ts',
      '@@ -1 +1,2 @@',
      '-const stary = 1;',
      '+const stawkaVat = 23;',
      '+const b = 2;',
      'diff --git a/lib/nowy.ts b/lib/nowy.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/lib/nowy.ts',
      '@@ -0,0 +1 @@',
      '+export const termin = 1;',
      'diff --git a/lib/usuniety.ts b/lib/usuniety.ts',
      'deleted file mode 100644',
      '--- a/lib/usuniety.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-export const x = 1;',
      'diff --git a/lib/stara-nazwa.ts b/lib/nowa-nazwa.ts',
      'similarity index 100%',
      'rename from lib/stara-nazwa.ts',
      'rename to lib/nowa-nazwa.ts',
    ].join('\n');
    expect(plikiZDiffu(diff)).toEqual([
      { plik: 'lib/a.ts', tresc: 'const stawkaVat = 23;\nconst b = 2;' },
      { plik: 'lib/nowy.ts', tresc: 'export const termin = 1;' },
      { plik: 'lib/usuniety.ts', tresc: '' },
      { plik: 'lib/stara-nazwa.ts', tresc: '' },
      { plik: 'lib/nowa-nazwa.ts', tresc: '' },
    ]);
  });

  it('linia „+++” w treści dodanej linii nie myli parsera', () => {
    const diff = [
      'diff --git a/lib/a.ts b/lib/a.ts',
      '--- a/lib/a.ts',
      '+++ b/lib/a.ts',
      '@@ -0,0 +1 @@',
      '+++licznik;',
    ].join('\n');
    expect(plikiZDiffu(diff)).toEqual([{ plik: 'lib/a.ts', tresc: '++licznik;' }]);
  });
});

describe('osłabienie mapy (do zgody zgoda:zmiana-filtra)', () => {
  const pliki = ['lib/podatki/zus.ts', 'lib/pulpit/a.ts', 'app/page.tsx'];

  it('mapa bez zmian i zaostrzenia nie są osłabieniem', () => {
    expect(porownajMapy(surowaMapa(), surowaMapa(), pliki)).toEqual([]);
    const ostrzejsza = surowaMapa();
    ostrzejsza.obszary[1].poziom = 'R1';
    ostrzejsza.obszary.push({ id: 'nowy', poziom: 'R1', opis: 'Nowy obszar R1.', sciezki: ['lib/nowy/**'] });
    ostrzejsza.obszary[0].sciezki.push('lib/inne/**');
    ostrzejsza.sygnaly.tresc.push({ id: 'nowy', wzorzec: 'abc' });
    ostrzejsza.kod.katalogi.push('hooks/');
    expect(porownajMapy(surowaMapa(), ostrzejsza, pliki)).toEqual([]);
  });

  it.each([
    ['usunięty obszar', (m: ReturnType<typeof surowaMapa>) => m.obszary.splice(1, 1), /usunięty obszar szacunki/],
    ['niższy poziom', (m: ReturnType<typeof surowaMapa>) => (m.obszary[0].poziom = 'R2'), /silniki: poziom R1 → R2/],
    ['usunięta ścieżka', (m: ReturnType<typeof surowaMapa>) => (m.obszary[0].sciezki = ['lib/podatki/zus.ts']), /usunięta ścieżka lib\/podatki\/\*\*/],
    ['nowe wyłączenie', (m: ReturnType<typeof surowaMapa>) => m.wylaczenia.push({ sciezki: ['lib/podatki/**'], powod: 'Bo tak, zdanie dla testu.' }), /nowe wyłączenie lib\/podatki/],
    ['usunięty sygnał', (m: ReturnType<typeof surowaMapa>) => m.sygnaly.tresc.splice(0, 1), /sygnał treści: usunięty albo zmieniony vat/],
    ['zmieniony sygnał', (m: ReturnType<typeof surowaMapa>) => (m.sygnaly.nazwy[0].wzorzec = '^vat$'), /sygnał nazwy: usunięty albo zmieniony podatki/],
    ['usunięty katalog kodu', (m: ReturnType<typeof surowaMapa>) => (m.kod.katalogi = ['app/']), /usunięty katalog kodu lib\//],
    ['nowe pomijanie', (m: ReturnType<typeof surowaMapa>) => m.kod.pomijane.push('lib/**'), /nowy pomijany wzorzec kodu lib\/\*\*/],
  ])('%s', (_opis, oslab, oczekiwane) => {
    const nowa = surowaMapa();
    oslab(nowa);
    expect(porownajMapy(surowaMapa(), nowa, pliki).join('\n')).toMatch(oczekiwane);
  });

  it('spadek poziomu konkretnego pliku jest widoczny nawet przy przeniesieniu ścieżki', () => {
    const nowa = surowaMapa();
    nowa.obszary[0].sciezki = ['lib/podatki/inne/**'];
    nowa.obszary[1].sciezki.push('lib/podatki/zus.ts');
    expect(porownajMapy(surowaMapa(), nowa, pliki)).toContain('plik lib/podatki/zus.ts: poziom R1 → R2');
  });
});

describe('martwe wzorce', () => {
  it('wzorzec, do którego nie pasuje żaden plik, jest zgłaszany z miejscem', () => {
    expect(martweWzorce(mapa, ['lib/podatki/zus.ts', 'app/page.tsx'])).toEqual(
      expect.arrayContaining([
        { wzorzec: 'lib/pulpit/{a,b}.ts', gdzie: 'szacunki' },
        { wzorzec: 'lib/auth/**', gdzie: 'wylaczenia[0]' },
      ]),
    );
  });
});

describe('prawdziwa mapa', () => {
  it('wczytuje się i ma poprawną budowę', () => {
    expect(() => wczytajMape()).not.toThrow();
  });
});

describe('poprawki po przeglądzie (drugi czytelnik F1)', () => {
  it('dodana linia „++ x” w hunku nie jest nagłówkiem pliku', () => {
    const diff = ['diff --git a/lib/a.ts b/lib/a.ts', '--- a/lib/a.ts', '+++ b/lib/a.ts', '@@ -0,0 +1,2 @@', '+++ licznik', '+const vat = 1;'].join('\n');
    expect(plikiZDiffu(diff)).toEqual([{ plik: 'lib/a.ts', tresc: '++ licznik\nconst vat = 1;' }]);
  });

  it('`**` w środku nazwy nie przechodzi przez katalogi', () => {
    expect(pasujeDoWzorca('lib/ksef/duplicate**.ts', 'lib/ksef/duplicate-check.ts')).toBe(true);
    expect(pasujeDoWzorca('lib/ksef/duplicate**.ts', 'lib/ksef/duplicate/x/y.ts')).toBe(false);
  });

  it('nazwa katalogu też jest sygnałem', () => {
    expect(sygnalyNazwy(mapa, 'lib/tax/index.ts')).toEqual(['nazwa:podatki']);
    expect(klasyfikujPlik(mapa, 'lib/tax/index.ts', { tresc: 'export {};' })).toMatchObject({ status: 'niesklasyfikowany' });
  });
});
