// Wyrocznia z „czystego pokoju” (żelazny filtr F6, plan B4.4): napisana 9.11.2026
// przez osobną sesję na innym modelu (Claude Sonnet) tylko ze specyfikacji
// tests/filtr/wyrocznia/SPEC-skladki.md (przepisy), bez wglądu w kod aplikacji.
// Nie importuje aplikacji (reguła statyczna wyrocznia-osobno). Zmiana tego
// pliku to zmiana wiedzy filtra (zgoda:wiedza-prawna); poprawiamy ją tylko
// wtedy, gdy błąd jest w wyroczni, a nie w aplikacji, i z uzasadnieniem w PR.
//
export interface ParametryZdrowotnej {
  stawkaPb: number;
  stawkaLiniowyPb: number;
  przecietneIvKwGr: number;
  placaMinimalnaGr: number;
  progRyczaltu60Gr: number;
  progRyczaltu300Gr: number;
}

function pb(a: bigint, stawka: number): bigint {
  const d = BigInt(10000);
  return (a * BigInt(stawka) * BigInt(2) + d) / (d * BigInt(2));
}

export function zdrowotnaRyczaltuWyrocznia(przychodNarastajacoGr: number, p: ParametryZdrowotnej): number {
  const przychod = BigInt(przychodNarastajacoGr);
  let mnoznikPb: number;
  if (przychod <= BigInt(p.progRyczaltu60Gr)) mnoznikPb = 6000;
  else if (przychod <= BigInt(p.progRyczaltu300Gr)) mnoznikPb = 10000;
  else mnoznikPb = 18000;
  const podstawa = pb(BigInt(p.przecietneIvKwGr), mnoznikPb);
  return Number(pb(podstawa, p.stawkaPb));
}

export function zdrowotnaOdDochoduWyrocznia(forma: 'skala' | 'liniowy', dochodGr: number, p: ParametryZdrowotnej): number {
  let dochod = BigInt(dochodGr);
  if (dochod < BigInt(0)) dochod = BigInt(0);
  const stawka = forma === 'skala' ? p.stawkaPb : p.stawkaLiniowyPb;
  const skladka = pb(dochod, stawka);
  const minimum = pb(BigInt(p.placaMinimalnaGr), p.stawkaPb);
  return Number(skladka > minimum ? skladka : minimum);
}
