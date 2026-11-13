// Wyrocznia z „czystego pokoju” (żelazny filtr F6, plan B4.4): napisana 9.11.2026
// przez osobną sesję na innym modelu (Claude Sonnet) tylko ze specyfikacji
// tests/filtr/wyrocznia/SPEC-skladki.md (przepisy), bez wglądu w kod aplikacji.
// Nie importuje aplikacji (reguła statyczna wyrocznia-osobno). Zmiana tego
// pliku to zmiana wiedzy filtra (zgoda:wiedza-prawna); poprawiamy ją tylko
// wtedy, gdy błąd jest w wyroczni, a nie w aplikacji, i z uzasadnieniem w PR.
//
export interface WejscieRyczaltuWyrocznia {
  przychodWgStawek: Array<[number, number]>;
  ujemneZPoprzednich: Array<[number, number]>;
  spoleczneZaplaconeGr: number;
  zdrowotnaZaplaconaGr: number;
  nadwyzkaZPoprzednichGr: number;
  odliczenieZdrowotnejPb: number;
}
export interface WynikRyczaltuWyrocznia {
  ryczaltGr: number;
  odliczonoGr: number;
  nadwyzkaNaKolejneGr: number;
  podstawaWgStawek: Array<[number, number]>;
  ujemneNaKolejne: Array<[number, number]>;
}

export function ryczaltWyrocznia(w: WejscieRyczaltuWyrocznia): WynikRyczaltuWyrocznia {
  const zero = BigInt(0);
  const sto = BigInt(100);
  const suma = new Map<number, bigint>();
  const dodaj = (lista: Array<[number, number]>) => {
    for (const [s, k] of lista) suma.set(s, (suma.get(s) ?? zero) + BigInt(k));
  };
  dodaj(w.przychodWgStawek);
  dodaj(w.ujemneZPoprzednich);

  const stawkiMalejaco = Array.from(suma.keys()).sort((a, b) => b - a);
  const dodatnie: Array<[number, bigint]> = [];
  const ujemne: Array<[number, number]> = [];
  for (const s of stawkiMalejaco) {
    const v = suma.get(s) as bigint;
    if (v > zero) dodatnie.push([s, v]);
    else if (v < zero) ujemne.push([s, Number(v)]);
  }

  const d = BigInt(10000);
  const zdr = BigInt(w.zdrowotnaZaplaconaGr);
  const odlZdr = (zdr * BigInt(w.odliczenieZdrowotnejPb) * BigInt(2) + d) / (d * BigInt(2));
  const dostepne = BigInt(w.nadwyzkaZPoprzednichGr) + BigInt(w.spoleczneZaplaconeGr) + odlZdr;
  let sumaPrzychodow = zero;
  for (const [, v] of dodatnie) sumaPrzychodow += v;
  const odliczono = dostepne < sumaPrzychodow ? dostepne : sumaPrzychodow;
  const nadwyzka = dostepne - odliczono;

  // podzial dokladny (bez groszy): podstawa = przychod * (suma - odliczono) / suma,
  // do pelnych zlotych (50 gr w gore), jedno dzielenie calkowite
  const podstawy: Array<[number, number]> = [];
  let licznikRyczaltu = zero;
  for (const [s, v] of dodatnie) {
    const mian = sto * sumaPrzychodow * BigInt(2);
    const zl = (v * (sumaPrzychodow - odliczono) * BigInt(2) + sto * sumaPrzychodow) / mian;
    const pod = zl * sto;
    podstawy.push([s, Number(pod)]);
    licznikRyczaltu += pod * BigInt(s);
  }
  // ryczalt w groszach = licznik / 10000; do pelnych zlotych: licznik / 1_000_000
  const m = d * sto;
  const ryczaltZl = (licznikRyczaltu * BigInt(2) + m) / (m * BigInt(2));
  return {
    ryczaltGr: Number(ryczaltZl * sto),
    odliczonoGr: Number(odliczono),
    nadwyzkaNaKolejneGr: Number(nadwyzka),
    podstawaWgStawek: podstawy,
    ujemneNaKolejne: ujemne,
  };
}
