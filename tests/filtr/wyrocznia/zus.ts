// Wyrocznia z „czystego pokoju” (żelazny filtr F6, plan B4.4): napisana 9.11.2026
// przez osobną sesję na innym modelu (Claude Sonnet) tylko ze specyfikacji
// tests/filtr/wyrocznia/SPEC-skladki.md (przepisy), bez wglądu w kod aplikacji.
// Nie importuje aplikacji (reguła statyczna wyrocznia-osobno). Zmiana tego
// pliku to zmiana wiedzy filtra (zgoda:wiedza-prawna); poprawiamy ją tylko
// wtedy, gdy błąd jest w wyroczni, a nie w aplikacji, i z uzasadnieniem w PR.
//
export type EtapZusWyrocznia = 'pelny' | 'preferencyjny' | 'ulga_na_start' | 'etat_obok';
export interface ParametryZus {
  prognozowanePrzecietneGr: number;
  placaMinimalnaGr: number;
  podstawaPelnaPb: number;
  podstawaPreferencyjnaPb: number;
  emerytalnaPb: number; rentowaPb: number; chorobowaPb: number;
  wypadkowaDoMarcaPb: number; wypadkowaOdKwietniaPb: number; funduszPracyPb: number;
}
export interface SkladkiZusWyrocznia {
  podstawaGr: number; emerytalnaGr: number; rentoweGr: number; chorobowaGr: number;
  wypadkowaGr: number; razemGr: number; funduszPracyGr: number;
}

// a * b / 10000, do grosza, polowka w gore (wartosci nieujemne)
function pb(a: bigint, stawka: number): bigint {
  const d = BigInt(10000);
  return (a * BigInt(stawka) * BigInt(2) + d) / (d * BigInt(2));
}

export function skladkiWyrocznia(etap: EtapZusWyrocznia, chorobowe: boolean, miesiac: number, p: ParametryZus): SkladkiZusWyrocznia {
  if (etap === 'ulga_na_start' || etap === 'etat_obok') {
    return { podstawaGr: 0, emerytalnaGr: 0, rentoweGr: 0, chorobowaGr: 0, wypadkowaGr: 0, razemGr: 0, funduszPracyGr: 0 };
  }
  const podstawa = etap === 'pelny'
    ? pb(BigInt(p.prognozowanePrzecietneGr), p.podstawaPelnaPb)
    : pb(BigInt(p.placaMinimalnaGr), p.podstawaPreferencyjnaPb);
  const em = pb(podstawa, p.emerytalnaPb);
  const re = pb(podstawa, p.rentowaPb);
  const ch = chorobowe ? pb(podstawa, p.chorobowaPb) : BigInt(0);
  const wypStawka = miesiac <= 3 ? p.wypadkowaDoMarcaPb : p.wypadkowaOdKwietniaPb;
  const wy = pb(podstawa, wypStawka);
  const fp = etap === 'pelny' ? pb(podstawa, p.funduszPracyPb) : BigInt(0);
  return {
    podstawaGr: Number(podstawa),
    emerytalnaGr: Number(em),
    rentoweGr: Number(re),
    chorobowaGr: Number(ch),
    wypadkowaGr: Number(wy),
    razemGr: Number(em + re + ch + wy),
    funduszPracyGr: Number(fp),
  };
}
