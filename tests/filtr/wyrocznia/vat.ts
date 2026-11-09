// Wyrocznia: część deklaracyjna JPK_V7M z ewidencji (SPEC-vat.md). Tylko liczby całkowite.

export type Stawka = '23' | '8' | '5' | '0' | 'zw' | 'np' | 'np_ii';
export interface KwotaStawki { stawka: Stawka; netto: number; vat: number } // grosze
export interface Zakup { netto: number; vatDoOdliczenia: number } // grosze
export interface Wejscie { sprzedaz: KwotaStawki[][]; zakupy: Zakup[]; nadwyzkaPoprzednia: number }

const STAWKI: readonly string[] = ['23', '8', '5', '0', 'zw', 'np', 'np_ii'];

/** Art. 63 § 1 OP (SPEC pkt 3): od wartości bezwzględnej, końcówka >= 50 gr w górę, znak zachowany. */
export function zaokraglijDoZlotych(grosze: number): number {
  if (!Number.isSafeInteger(grosze)) throw new Error(`Grosze muszą być liczbą całkowitą: ${grosze}`);
  const abs = Math.abs(grosze);
  let zl = (abs - (abs % 100)) / 100;
  if (abs % 100 >= 50) zl += 1;
  // Unikamy zwracania -0.
  return grosze < 0 && zl !== 0 ? -zl : zl;
}

function calkowita(x: number, nazwa: string): number {
  if (!Number.isSafeInteger(x)) throw new Error(`${nazwa}: wymagana liczba całkowita (grosze), jest ${x}`);
  return x;
}

/** Pola deklaracji w pełnych złotych (SPEC pkt 2-4). */
export function deklaracja(w: Wejscie): Record<string, number> {
  // Sumy ewidencji K_* w groszach (SPEC pkt 2).
  const K = { k10: 0, k11: 0, k12: 0, k13: 0, k15: 0, k16: 0, k17: 0, k18: 0, k19: 0, k20: 0, k42: 0, k43: 0 };

  for (const dok of w.sprzedaz) {
    for (const p of dok) {
      if (!STAWKI.includes(p.stawka)) throw new Error(`Nieznana stawka: ${String(p.stawka)}`);
      const netto = calkowita(p.netto, 'netto');
      const vat = calkowita(p.vat, 'vat');
      if ((p.stawka === '0' || p.stawka === 'zw' || p.stawka === 'np' || p.stawka === 'np_ii') && vat !== 0) {
        throw new Error(`Stawka ${p.stawka} wymaga VAT = 0`);
      }
      switch (p.stawka) {
        case 'zw': K.k10 += netto; break;
        case 'np': K.k11 += netto; break;
        case 'np_ii': K.k11 += netto; K.k12 += netto; break; // K_12 to część K_11
        case '0': K.k13 += netto; break;
        case '5': K.k15 += netto; K.k16 += vat; break;
        case '8': K.k17 += netto; K.k18 += vat; break;
        case '23': K.k19 += netto; K.k20 += vat; break;
      }
    }
  }
  for (const z of w.zakupy) {
    K.k42 += calkowita(z.netto, 'zakup.netto');
    K.k43 += calkowita(z.vatDoOdliczenia, 'zakup.vatDoOdliczenia');
  }
  if (!Number.isSafeInteger(w.nadwyzkaPoprzednia) || w.nadwyzkaPoprzednia < 0) {
    throw new Error(`nadwyzkaPoprzednia: wymagana całkowita >= 0, jest ${w.nadwyzkaPoprzednia}`);
  }

  // Każde pole zaokrąglane osobno (SPEC pkt 3).
  const P_10 = zaokraglijDoZlotych(K.k10);
  const P_11 = zaokraglijDoZlotych(K.k11);
  const P_12 = zaokraglijDoZlotych(K.k12);
  const P_13 = zaokraglijDoZlotych(K.k13);
  const P_15 = zaokraglijDoZlotych(K.k15);
  const P_16 = zaokraglijDoZlotych(K.k16);
  const P_17 = zaokraglijDoZlotych(K.k17);
  const P_18 = zaokraglijDoZlotych(K.k18);
  const P_19 = zaokraglijDoZlotych(K.k19);
  const P_20 = zaokraglijDoZlotych(K.k20);
  const P_42 = zaokraglijDoZlotych(K.k42);
  const P_43 = zaokraglijDoZlotych(K.k43);

  // Sumy i rozliczenie (SPEC pkt 4); P_12 nie wchodzi do P_37.
  const P_37 = P_10 + P_11 + P_13 + P_15 + P_17 + P_19;
  const P_38 = P_16 + P_18 + P_20;
  const P_39 = w.nadwyzkaPoprzednia;
  const P_48 = P_39 + P_43;
  const P_51 = P_38 > P_48 ? P_38 - P_48 : 0;
  const P_53 = P_48 > P_38 ? P_48 - P_38 : 0;
  const P_62 = P_53; // P_54 = 0

  return { P_10, P_11, P_12, P_13, P_15, P_16, P_17, P_18, P_19, P_20, P_37, P_38, P_39, P_42, P_43, P_48, P_51, P_53, P_62 };
}
