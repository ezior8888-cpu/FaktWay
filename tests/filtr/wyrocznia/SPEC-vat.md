# SPEC: część deklaracyjna JPK_V7M (VAT-7) z ewidencji, dla JDG

Źródła: ustawa o VAT (art. 99 ust. 1, art. 103 ust. 1, art. 87 ust. 1, art. 100 ust. 1
pkt 4), Ordynacja podatkowa (art. 63 § 1), opisy pól w oficjalnym schemacie JPK_V7M(3)
Ministerstwa Finansów (CRWDE 2025/12/19/14090), cytowane niżej.

## 1. Wejście

Kwoty wejściowe są w groszach (liczby całkowite, mogą być ujemne: korekty).

- `sprzedaz`: lista dokumentów sprzedaży; każdy dokument to lista kwot według stawek
  `{ stawka, netto, vat }`. Stawki: '23', '8', '5', '0' (krajowa 0%), 'zw' (zwolniona),
  'np' (dostawa towarów lub usługa poza terytorium kraju), 'np_ii' (usługa z art. 100
  ust. 1 pkt 4 ustawy, czyli usługa dla podatnika z innego kraju UE rozliczana przez
  nabywcę; to też jest „poza terytorium kraju”). Dla '0', 'zw', 'np', 'np_ii' VAT = 0.
- `zakupy`: lista dokumentów zakupu z prawem do odliczenia `{ netto, vatDoOdliczenia }`
  (wszystko to „pozostałe towary i usługi”, bez środków trwałych).
- `nadwyzkaPoprzednia`: nadwyżka podatku naliczonego z poprzedniej deklaracji, w pełnych
  złotych, liczba całkowita >= 0.

## 2. Ewidencja: sumy pól (w groszach)

Najpierw sumy po wszystkich dokumentach:

| pole ewidencji | co zawiera |
|---|---|
| K_10 | netto stawki 'zw' |
| K_11 | netto stawek 'np' i 'np_ii' (oba są poza terytorium kraju) |
| K_12 | netto samej stawki 'np_ii' (to część K_11, „w tym”) |
| K_13 | netto stawki '0' |
| K_15, K_16 | netto i VAT stawki '5' |
| K_17, K_18 | netto i VAT stawki '8' |
| K_19, K_20 | netto i VAT stawki '23' |
| K_42, K_43 | netto i VAT do odliczenia wszystkich zakupów |

## 3. Zaokrąglenie do pełnych złotych (art. 63 § 1 Ordynacji podatkowej)

Kwoty w deklaracji są w pełnych złotych: końcówki poniżej 50 groszy pomija się,
końcówki 50 groszy i więcej podwyższa się do pełnych złotych. Kwoty ujemne
zaokrągla się tak samo od wartości bezwzględnej i dodaje znak minus, czyli
-10,49 zł daje -10 zł, a -10,50 zł daje -11 zł (interpretacja do potwierdzenia
z księgową; dodatnie bez wątpliwości).

Każde pole deklaracji z sumy ewidencji zaokrągla się osobno:
P_10 = zaokr(K_10), P_11 = zaokr(K_11), P_12 = zaokr(K_12), P_13 = zaokr(K_13),
P_15 = zaokr(K_15), P_16 = zaokr(K_16), P_17 = zaokr(K_17), P_18 = zaokr(K_18),
P_19 = zaokr(K_19), P_20 = zaokr(K_20), P_42 = zaokr(K_42), P_43 = zaokr(K_43).

## 4. Sumy i rozliczenie (opisy pól ze schematu MF)

- P_37: „Łączna wysokość podstawy opodatkowania. Suma kwot z P_10, P_11, P_13, P_15,
  P_17, P_19, P_21, P_22, P_23, P_25, P_27, P_29, P_31” (tu niewymienione pola są 0;
  P_12 NIE wchodzi, bo jest częścią P_11).
- P_38: „Łączna wysokość podatku należnego. Suma kwot z P_16, P_18, P_20, P_24, P_26,
  P_28, P_30, P_32, P_33, P_34 pomniejszona o kwotę z P_35, P_36 i P_360” (pola spoza
  tego zadania są 0).
- P_39: nadwyżka z poprzedniej deklaracji (`nadwyzkaPoprzednia`).
- P_48: „Łączna wysokość podatku naliczonego do odliczenia. Suma kwot z P_39, P_41,
  P_43, P_44, P_45, P_46 i P_47” (pola spoza zadania są 0).
- P_51 (podatek do wpłaty, art. 103 ust. 1): jeżeli P_38 > P_48, to P_38 - P_48
  (P_49 i P_50 w tym zadaniu są 0); w przeciwnym razie 0.
- P_53 (nadwyżka naliczonego nad należnym, art. 87 ust. 1): jeżeli P_48 > P_38, to
  P_48 - P_38 (P_52 jest 0); w przeciwnym razie 0.
- P_54 (zwrot na rachunek) jest 0, więc P_62 (nadwyżka do przeniesienia na następny
  okres) = P_53.

## 5. Interfejs do napisania (TypeScript, jeden plik, bez importów)

```ts
export type Stawka = '23' | '8' | '5' | '0' | 'zw' | 'np' | 'np_ii';
export interface KwotaStawki { stawka: Stawka; netto: number; vat: number } // grosze
export interface Zakup { netto: number; vatDoOdliczenia: number } // grosze
export interface Wejscie { sprzedaz: KwotaStawki[][]; zakupy: Zakup[]; nadwyzkaPoprzednia: number }
/** Art. 63 § 1 OP z punktu 3: grosze (całkowite) -> pełne złote (całkowite). */
export function zaokraglijDoZlotych(grosze: number): number;
/** Pola deklaracji w pełnych złotych: P_10, P_11, P_12, P_13, P_15, P_16, P_17, P_18,
 *  P_19, P_20, P_37, P_38, P_39, P_42, P_43, P_48, P_51, P_53, P_62 (wszystkie klucze
 *  zawsze obecne, także gdy 0). */
export function deklaracja(w: Wejscie): Record<string, number>;
```

Kwoty licz na liczbach całkowitych (grosze), bez liczb zmiennoprzecinkowych w
zaokrągleniu. Nieprawidłowe wejście (niecałkowite grosze, nieznana stawka, VAT różny
od 0 przy '0', 'zw', 'np', 'np_ii', ujemna albo niecałkowita nadwyżka): rzuć błąd.
