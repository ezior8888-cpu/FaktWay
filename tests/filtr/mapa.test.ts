import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CO_ZROBIC_NIESKLASYFIKOWANY, KATALOG_REPO, skanujRepozytorium, wczytajMape } from '@/scripts/filtr/mapa.mjs';

/**
 * Pełny skan repozytorium mapą ryzyka (żelazny filtr F1, plan B3 pkt 4).
 *
 * Czerwony test znaczy: nowy plik z sygnałem (VAT, składka, termin, kurs,
 * JPK, KSeF, `P_\d+`, import pliku R1…) nie trafił na mapę albo wpis mapy
 * wskazuje plik, którego już nie ma. Naprawa: dopisz plik do obszaru
 * w `filtr/mapa-ryzyka.json` (wolno bez zgody) albo do wyłączeń z powodem
 * (za zgodą Bartosza); martwy wzorzec popraw albo usuń.
 */

const mapa = wczytajMape();
const skan = skanujRepozytorium(mapa);

describe('mapa ryzyka: pełny skan repozytorium', () => {
  it('żaden plik kodu z sygnałem nie jest poza mapą', () => {
    const lista = skan.niesklasyfikowane.map((p) => `${p.plik} (sygnały: ${p.sygnaly.slice(0, 5).join(', ')})`);
    expect(lista, `Pliki poza mapą:\n${lista.join('\n')}\n\n${CO_ZROBIC_NIESKLASYFIKOWANY}`).toEqual([]);
  });

  it('żaden wzorzec mapy nie jest martwy', () => {
    const lista = skan.martweWzorce.map((m) => `${m.wzorzec} (${m.gdzie})`);
    expect(lista, `Wzorce bez pliku (plik usunięty albo przeniesiony?):\n${lista.join('\n')}`).toEqual([]);
  });

  it('każdy plik kodu ma poziom', () => {
    for (const wynik of skan.wyniki) expect(['R1', 'R2', 'R3', 'R0']).toContain(wynik.poziom);
    expect(skan.wyniki.length).toBeGreaterThan(1000);
  });

  it('obszary R1 z planu (B2) są na mapie z poziomem R1', () => {
    const r1 = new Set(mapa.obszary.filter((o: { poziom: string }) => o.poziom === 'R1').map((o: { id: string }) => o.id));
    const wymagane = [
      'ksiegowosc.parametry',
      'ksiegowosc.kalendarz',
      'ksiegowosc.mikrorachunek',
      'ksiegowosc.silniki',
      'ksiegowosc.kpir',
      'ksiegowosc.vat',
      'ksiegowosc.rozliczenia',
      'ksiegowosc.jpk-pit',
      'ksiegowosc.wysylka-jpk',
      'ksiegowosc.modul',
      'faktury.kwoty',
      'faktury.fa3',
      'faktury.korekty',
      'faktury.zaliczki',
      'ksef.wysylka',
      'ksef.duplikaty',
      'ksef.offline-upo',
      'waluty',
      'jpk.vat-fa',
      'raporty.kpir',
      'koszty',
      'kontrahent',
      'windykacja',
      'abonament',
      'retencja',
    ];
    expect(wymagane.filter((id) => !r1.has(id))).toEqual([]);
  });

  it('kluczowe pliki mają oczekiwany poziom', () => {
    const poziom = (plik: string) => skan.wyniki.find((w) => w.plik === plik)?.poziom;
    expect(poziom('lib/ksiegowosc/zus.ts')).toBe('R1');
    expect(poziom('lib/xml/fa3-generator.ts')).toBe('R1');
    expect(poziom('lib/exports/jpk-v7m-generator.ts')).toBe('R1');
    expect(poziom('lib/ksef/submit.ts')).toBe('R1');
    expect(poziom('lib/dashboard/tax-estimate.ts')).toBe('R2');
    expect(poziom('lib/format/warsaw-date.ts')).toBe('R3');
    expect(poziom('lib/ksef/client.ts')).toBe('R3');
  });

  it.todo('każdy obszar R1 ma w rejestrze przepisów co najmniej jedną regułę (od kroku F4)');
  it.todo('każda ścieżka R1 jest w CODEOWNERS (od kroku F18)');
});

describe('mapa ryzyka: polecenie', () => {
  const uruchom = (argumenty: string[]) => {
    try {
      return { kod: 0, wyjscie: execFileSync('node', [join(KATALOG_REPO, 'scripts/filtr/mapa.mjs'), ...argumenty], { encoding: 'utf8' }) };
    } catch (blad) {
      const b = blad as { status: number; stdout: string };
      return { kod: b.status, wyjscie: b.stdout };
    }
  };

  it('klasyfikuje podane pliki i podaje poziom zmiany', () => {
    const wynik = uruchom(['lib/ksiegowosc/zus.ts', 'lib/format/pl.ts']);
    expect(wynik.kod).toBe(0);
    expect(wynik.wyjscie).toContain('[FILTR] Poziom zmiany: R1 krytyczny');
    expect(wynik.wyjscie).toMatch(/R1 {2}lib\/ksiegowosc\/zus\.ts {2}\(ksiegowosc\.silniki/);
  });

  it('JSON dla straży i hooków', () => {
    const wynik = uruchom(['--json', 'lib/format/pl.ts']);
    expect(JSON.parse(wynik.wyjscie)).toMatchObject({ poziom: 'R3', niesklasyfikowane: [] });
  });

  it('złe użycie kończy się kodem 2', () => {
    expect(uruchom([]).kod).toBe(2);
  });
});
