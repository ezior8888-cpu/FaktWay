// Wyrocznia z „czystego pokoju” (żelazny filtr F6, plan B4.4): napisana 9.11.2026
// przez osobną sesję na innym modelu (Claude Sonnet) tylko ze specyfikacji
// tests/filtr/wyrocznia/SPEC-pit.md (przepisy), bez wglądu w kod aplikacji.
// Nie importuje aplikacji (reguła statyczna wyrocznia-osobno). Zmiana tego
// pliku to zmiana wiedzy filtra (zgoda:wiedza-prawna); poprawiamy ją tylko
// wtedy, gdy błąd jest w wyroczni, a nie w aplikacji, i z uzasadnieniem w PR.
// Literały BigInt (`0n`) zamienione mechanicznie na BigInt(0), bo repozytorium kompiluje do ES2017.
//
// Wyrocznia PIT JDG 2026. Sprawdzone ręcznie:
// (a) skala, 1 miesiąc, przychód 140 000 zł, koszty 10 000 zł, bez składek
//     -> podstawa 130 000 zł, podatek 10 800 + 32% x 10 000 = 14 000 zł, zaliczka 14 000 zł.
// (b) liniowy, 1 miesiąc, przychód 10 000,49 zł, koszty 0, społeczne 1 000 zł, zdrowotna 500 zł
//     -> podstawa 8 500 zł (z 8 500,49 zł), podatek 1 615 zł, zaliczka 1 615 zł.

export type FormaPitWyrocznia = 'skala' | 'liniowy';

export interface MiesiacWejscia {
  przychodGr: number;
  kosztyGr: number;
  spoleczneZaplaconeGr: number;
  zdrowotnaZaplaconaGr: number;
}

export interface ParametryPit {
  skalaStawka1Pb: number;
  skalaStawka2Pb: number;
  skalaProgGr: number;
  kwotaZmniejszajacaGr: number;
  liniowyStawkaPb: number;
  limitZdrowotnejGr: number;
}

export interface MiesiacWyniku {
  podstawaNarastajacoGr: number;
  podatekNarastajacoGr: number;
  zaliczkaGr: number;
}

const STO = BigInt(100);
const PB = BigInt(10000);

// pkt 5: zaokrąglenie do pełnych złotych (50 gr i więcej w górę), wartość nieujemna
function naZlote(gr: bigint): bigint {
  return ((gr + BigInt(50)) / STO) * STO;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function zaliczkiWyrocznia(
  forma: FormaPitWyrocznia,
  miesiace: MiesiacWejscia[],
  p: ParametryPit,
): MiesiacWyniku[] {
  const wynik: MiesiacWyniku[] = [];
  let przychod = BigInt(0);
  let koszty = BigInt(0);
  let spol = BigInt(0);
  let zdr = BigInt(0);
  let poprzednieZaliczki = BigInt(0);

  for (const m of miesiace) {
    przychod += BigInt(m.przychodGr);
    koszty += BigInt(m.kosztyGr);
    spol += BigInt(m.spoleczneZaplaconeGr);
    zdr += BigInt(m.zdrowotnaZaplaconaGr);

    // pkt 2: dochód narastająco (może być ujemny)
    const dochod = przychod - koszty;
    // pkt 3: składki społeczne tylko do wysokości dochodu, przy stracie 0
    let reszta = dochod > BigInt(0) ? dochod : BigInt(0);
    const odlSpol = min(spol, reszta);
    reszta -= odlSpol;
    // pkt 4: zdrowotna tylko przy liniowym, do limitu rocznego i do reszty dochodu
    if (forma === 'liniowy') {
      const odlZdr = min(min(zdr, BigInt(p.limitZdrowotnejGr)), reszta);
      reszta -= odlZdr;
    }
    // pkt 5: podstawa w pełnych złotych
    const podstawa = naZlote(reszta);

    let podatek: bigint;
    if (forma === 'liniowy') {
      // pkt 7
      podatek = (podstawa * BigInt(p.liniowyStawkaPb)) / PB;
    } else {
      // pkt 6
      const prog = BigInt(p.skalaProgGr);
      const s1 = BigInt(p.skalaStawka1Pb);
      const s2 = BigInt(p.skalaStawka2Pb);
      const kwota = BigInt(p.kwotaZmniejszajacaGr);
      if (podstawa <= prog) {
        podatek = (podstawa * s1) / PB - kwota;
        if (podatek < BigInt(0)) podatek = BigInt(0);
      } else {
        podatek = (prog * s1) / PB - kwota + ((podstawa - prog) * s2) / PB;
      }
    }

    // pkt 1, 5, 8: zaliczka = podatek narastająco minus wcześniejsze zaliczki, zaokrąglona, min 0
    const roznica = podatek - poprzednieZaliczki;
    const zaliczka = roznica > BigInt(0) ? naZlote(roznica) : BigInt(0);
    poprzednieZaliczki += zaliczka;

    wynik.push({
      podstawaNarastajacoGr: Number(podstawa),
      podatekNarastajacoGr: Number(podatek),
      zaliczkaGr: Number(zaliczka),
    });
  }
  return wynik;
}
