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

## Czujka zmian schematu MF

Workflow `.github/workflows/czujka-schematu-fa3.yml` (wtorek rano i ręcznie
z zakładki Actions) uruchamia `scripts/ci/czujka-schematu-fa3.mjs`:

- **crd.gov.pl**: pliki spod adresów przestrzeni nazw (`schemat.xsd`
  i trzy pliki `*_v10-0E.xsd`) porównane ze skrótem kopii w
  `lib/xml/schemas/fa3/`. Normalizacja: końce linii i `schemaLocation`
  z pełnym adresem MF zamienione na samą nazwę pliku. Łapie poprawki MF
  wprowadzone w miejscu.
- **`CIRFMF/ksef-api`** (dawniej `ksef-docs`; `faktury/schemy/FA`): nowy plik (np. nowa wersja
  FA), zmieniony albo usunięty względem listy `ZNANE_W_DOCS` w skrypcie.
  Zmiany FA(2) są pomijane.

Różnica zakłada issue z etykietą `czujka-fa3`: tabela plików, diff nazw
elementów, typów i wartości wyliczeń, odcisk wersji w znaczniku. Ta sama
wersja MF nie zakłada drugiego issue; inna przy otwartym issue aktualizuje je
i dodaje komentarz. MF niedostępny: ostrzeżenie w logu przebiegu, bez issue.

Co zrobić z issue:

1. Przeczytaj komunikat MF (podatki.gov.pl/ksef, `api-changelog.md`
   w `ksef-api`): poprawka w miejscu czy nowa wersja z datą obowiązywania.
2. Pobierz nowe pliki do `lib/xml/schemas/fa3/`. `schemat.xsd` zostaje jak
   z MF; `schemat-local.xsd` (używa go walidator) to ta sama treść
   z `schemaLocation="StrukturyDanych_v10-0E.xsd"`, a pliki bazowe
   z `schemaLocation` na samą nazwę pliku.
3. Nowa wersja (nowa przestrzeń nazw): `FA3_NAMESPACE` we wszystkich
   generatorach (`grep -rl "crd.gov.pl/wzor/2025/06/25/13775" lib`), kod
   formularza w wysyłce KSeF,
   `docs/fa3-schema-analysis.md`. Termin wejścia ustala Bartosz.
4. `pnpm verify:fa3`, `pnpm test`, pełny `pnpm vitest run`.
5. W tym samym PR zaktualizuj `ZNANE_W_DOCS` (skróty blobów:
   `gh api repos/CIRFMF/ksef-api/contents/faktury/schemy/FA -q '.[] | .path+" "+.sha'`).
   Ręczny przebieg czujki po scaleniu ma dać „zgodny z repo”.

Zamknięcie issue bez zmiany repo wycisza tę wersję MF.
