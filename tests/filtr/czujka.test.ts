import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { aktyOd, ocenAkt, terminyKalendarza, trescIssue, wczytajKonfiguracje } from '@/scripts/filtr/czujka-przepisow.mjs';
import { KATALOG_REPO } from '@/scripts/filtr/mapa.mjs';

/**
 * Czujka przepisów (żelazny filtr F15). Dane z ELI API Sejmu zapisane
 * 9.11.2026 w tests/fixtures/filtr/ (metadane aktów, bez sieci w teście).
 */
const konfiguracja = wczytajKonfiguracje();
const akt = (nazwa: string) => JSON.parse(readFileSync(join(KATALOG_REPO, 'tests/fixtures/filtr', nazwa), 'utf8'));

describe('czujka przepisów: akty z ELI API', () => {
  it('płaca minimalna 2027 (Dz.U. 2026 poz. 1213): wydana na podstawie ustawy o minimalnym wynagrodzeniu, tytuł też pasuje', () => {
    const t = ocenAkt(akt('eli-DU-2026-1213.json'), konfiguracja, '2026-09-01');
    expect(t).not.toBeNull();
    expect(t?.powody.join('\n')).toMatch(/Podstawa prawna: ustawa o minimalnym wynagrodzeniu/);
    expect(t?.powody.join('\n')).toMatch(/tytuł pasuje/);
    expect(t?.obszary).toContain('ksiegowosc.parametry');
  });

  it('nowelizacja ustawy o VAT (Dz.U. 2026 poz. 1446): akt zmieniony, wejście w życie w treści issue', () => {
    const t = ocenAkt(akt('eli-DU-2026-1446.json'), konfiguracja, '2026-09-01');
    expect(t?.powody).toContain('Akty zmienione: ustawa o podatku od towarów i usług');
    const { tytul, tresc } = trescIssue(t);
    expect(tytul).toMatch(/^\[czujka\] DU\/2026\/1446: Ustawa z dnia 8 października 2026/);
    expect(tresc).toMatch(/Wchodzi w życie: 2026-11-18/);
    expect(tresc).toMatch(/zgoda:wiedza-prawna/);
  });

  it('rozporządzenie o świadczeniach zdrowotnych nie jest trafieniem (składka jest w ustawie, nie w rozporządzeniach)', () => {
    expect(ocenAkt(akt('eli-DU-2026-1409.json'), konfiguracja, '2026-09-01')).toBeNull();
  });

  it('akt ogłoszony przed oknem nie jest trafieniem', () => {
    expect(ocenAkt(akt('eli-DU-2026-1446.json'), konfiguracja, '2026-11-01')).toBeNull();
  });

  it('kanał zmian czytany stronami do końca', async () => {
    const strony = [Array.from({ length: 500 }, (_, i) => ({ ELI: `DU/2026/${i}` })), [{ ELI: 'DU/2026/9999' }]];
    const adresy: string[] = [];
    const akty = await aktyOd('2026-11-01', async (url: string) => {
      adresy.push(url);
      return { items: strony[adresy.length - 1] ?? [] };
    });
    expect(akty).toHaveLength(501);
    expect(adresy[1]).toMatch(/offset=500/);
  });
});

describe('czujka przepisów: kalendarz ogłoszeń', () => {
  it('termin w oknie 14 dni przed i 30 po daje trafienie z parametrami do uzupełnienia', () => {
    const przed = terminyKalendarza(konfiguracja, '2026-09-05').map((t: { klucz: string }) => t.klucz);
    expect(przed).toContain('kalendarz placa-minimalna 2026');
    const po = terminyKalendarza(konfiguracja, '2027-02-10').map((t: { klucz: string }) => t.klucz);
    expect(po).toEqual(expect.arrayContaining(['kalendarz przecietne-iv-kwartal 2027', 'kalendarz prognozowane-wynagrodzenie 2027']));
    expect(terminyKalendarza(konfiguracja, '2026-11-09')).toEqual([]);
    const { tresc } = trescIssue(terminyKalendarza(konfiguracja, '2026-09-05')[0]);
    expect(tresc).toMatch(/zus\.placaMinimalna/);
  });

  it('każdy parametr z kalendarza istnieje w parametrach roku', async () => {
    const { PARAMETRY, wszystkieLiczby } = await import('@/lib/ksiegowosc/parametry');
    const klucze = new Set(wszystkieLiczby(PARAMETRY[2026]).map((w: { sekcja: string; klucz: string }) => `${w.sekcja}.${w.klucz}`));
    for (const wpis of konfiguracja.kalendarz) for (const p of wpis.parametry) expect(klucze.has(p), p).toBe(true);
  });
});

describe('czujka przepisów: konfiguracja', () => {
  it('akty obserwowane mają ELI w postaci DU/RRRR/poz i obszary z mapy', () => {
    const mapa = JSON.parse(readFileSync(join(KATALOG_REPO, 'filtr/mapa-ryzyka.json'), 'utf8'));
    const obszary = new Set(mapa.obszary.map((o: { id: string }) => o.id));
    for (const o of konfiguracja.obserwowane) {
      expect(o.eli).toMatch(/^(DU|MP)\/\d{4}\/\d+$/);
      for (const obszar of o.obszary) expect(obszary.has(obszar), `${o.eli} ${obszar}`).toBe(true);
    }
  });
});
