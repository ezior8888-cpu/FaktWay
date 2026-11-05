# FA(3) i KSeF: zanim zmienisz generator albo wysyłkę

Dla każdego, kto zmienia `lib/xml/` (generator i walidator FA(3)) albo
`lib/ksef/` (klient, wysyłka, skrzynka). Łamanie tych reguł oznacza fakturę,
która nie przejdzie lokalnej walidacji XSD i nigdy nie dotrze do KSeF.

## Środowisko i dane testowe

- `KSEF_ENV=test` albo `KSEF_ENV=production`: każda ścieżka rozróżnia oba.
- W testach tylko fikcyjny NIP `1234567890`, nigdy prawdziwy.
- Dane logowania KSeF w bazie są szyfrowane `KSEF_CREDENTIALS_ENCRYPTION_KEY`.

## Schemat (XSD MF v10-0E, `lib/xml/schemas/fa3/`)

- **Identyfikator nabywcy (`Podmiot2/DaneIdentyfikacyjne`)**: dozwolone są
  tylko `NIP`, `KodUE`+`NrVatUE`, `KodKraju` (opcjonalnie)+`NrID` albo
  `BrakID`. **Elementów `NrPESEL` ani `NrInny` nie ma.** Kiedyś były w
  generatorach i faktury B2C nigdy nie wychodziły. PESEL i numer dokumentu
  idą jako `KodKraju` `PL` + `NrID` (string 1–50). Dla konsumenta rozważ
  `BrakID` (RODO: minimalizacja danych).
- **`P_12` (stawka)**: `0 KR` (krajowa 0%), `0 WDT` i `0 EX` są poprawne.
  Rozróżnienie siedzi w `P_12` i w polu sumy (`P_13_6_1`, `P_13_6_2`,
  `P_13_6_3`). Logika: `lib/xml/fa3-p12.ts`.
- **`RodzajFaktury`**: `InvoiceType` w `types/invoice.ts` to już wartości
  XSD (`VAT`, `KOR`, `ZAL`, `ROZ`), emitowane wprost.
- Przestrzenie nazw i mapowanie pól: `docs/fa3-schema-analysis.md`.

## Walidacja przed wysyłką

- `submitInvoiceFullFlow` (`lib/ksef/submit-invoice-full.ts`) zawsze woła
  `validateInvoiceXml` (`lib/xml/validator.ts`, prawdziwy XSD) przed
  wysyłką, więc zła struktura zatrzymuje się lokalnie i nie zużywa sesji KSeF.
- Po każdej zmianie generatora: `pnpm verify:fa3`
  (`scripts/verify-fa3-all-types.ts`, wszystkie rodzaje faktur, XSD
  i arytmetyka `P_15 = Σ(P_13 + P_14)`), do tego `pnpm test` (testy tsx
  generatora, kalkulatora i walidatora).

## Błędy KSeF

Kody błędów i co robić: `docs/runbooks/ksef-error-codes.md`. Błędy wysyłki
na produkcji: `docs/runbooks/centrum-bledy-wysylki.md`.
