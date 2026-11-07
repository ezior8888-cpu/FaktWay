# E2E Tests (Playwright)

End-to-end testy uruchamiające prawdziwą przeglądarkę przeciw lokalnemu
Next.js dev serwerowi. Część Fazy 20 (Test Infrastructure).

## Kiedy używać

- **E2E (tutaj)** — user flows, multi-step interactions, browser-specific
  zachowanie (Safari quirks, mobile gestures, PWA install).
- **Vitest** (`tests/`) — RLS isolation (multi-tenancy security), integracja
  Supabase z service_role.
- **tsx --test** (`lib/xml/*.test.ts`) — czyste unit testy (kalkulator faktur,
  generator FA(3), walidator).

Reguła kciuka: jeśli coś można sprawdzić bez przeglądarki — robisz unit.

## Uruchomienie

```bash
# Pierwsze setup — pobiera browsery (~250MB)
pnpm test:e2e:install

# Wszystkie testy, wszystkie projekty (chromium/firefox/webkit/mobile-iphone/mobile-pixel
# i testy wizualne, sekcja „Testy wizualne”)
pnpm test:e2e

# Tryb interaktywny — UI runner Playwrighta z timeline i debugowaniem
pnpm test:e2e:ui

# Pojedynczy test
pnpm test:e2e e2e/tests/01-auth.spec.ts

# Pojedynczy projekt
pnpm test:e2e --project=chromium

# Z trace włączonym (debugowanie failed runs)
pnpm test:e2e --trace=on

# Otwórz raport HTML po runie
pnpm test:e2e:report
```

## Środowisko

E2E zakłada plik `.env.local` z:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
KSEF_CREDENTIALS_ENCRYPTION_KEY=...
```

Playwright sam podnosi dev server na porcie 3100 (zob. `playwright.config.ts`).
Jeśli już masz coś na 3100 — ustaw `E2E_PORT=3200` w env.

## Telefon

`tests/telefon-ekrany.spec.ts` loguje lokalne konto dev (`pnpm db:local`),
przechodzi po wszystkich ekranach panelu w projekcie `mobile-iphone` albo
`mobile-pixel` i sprawdza brak poziomego przewijania, uciętych przycisków
i błędów strony. Cele dotykowe mniejsze niż 44x44 trafiają do raportu
`test-results/telefon-raport-<projekt>.json`, nie oblewają testu.

```bash
E2E_PORT=3108 pnpm test:e2e e2e/tests/telefon-ekrany.spec.ts --project=mobile-iphone
# tylko wybrane trasy:
TELEFON_TRASY=/settings/account,/inbox E2E_PORT=3108 pnpm test:e2e e2e/tests/telefon-ekrany.spec.ts --project=mobile-iphone
```

Na hostach innych niż localhost test jest pomijany. Wyniki ostatniego obchodu:
`docs/qa/telefon-macierz.md`.

## Testy wizualne

Wygląd na Macu jest zamrożony od 03.11.2026 (`docs/runbooks/zmiany-na-telefon.md`).
`tests/wizualne.spec.ts` porównuje ekrany ze wzorcowymi zrzutami
w `tests/wizualne.spec.ts-snapshots/`: strona główna, sekcja `#telefon`,
menu hamburgera (tylko telefon), `/login`, pulpit i lista faktur. Dwa
projekty: `wizualne-iphone` (WebKit, iPhone 13) i `wizualne-desktop`
(Chromium 1440x900), oba z `reducedMotion: 'reduce'`. Pulpit i lista faktur
logują lokalne konto dev raz na przebieg (`wizualne-logowanie.ts`), więc
najpierw `pnpm db:local`.

```bash
E2E_PORT=3132 pnpm test:wizualne
```

Zielono = wygląd bez zmian. Czerwono = raport HTML (`pnpm test:e2e:report`)
pokazuje przy każdym ekranie wzorzec, nowy zrzut i obraz różnicy. Różowe
prostokąty na zrzutach panelu to maski: liczby, daty i wykresy zależą od
dzisiejszej daty i danych konta dev.

Zmiana wyglądu zamierzona i zaakceptowana przez Bartosza: odśwież wzorce
i dołącz je do tego samego PR.

```bash
E2E_PORT=3132 pnpm test:wizualne --update-snapshots
```

Wzorce mają w nazwie system (`-darwin.png`): powstają na Macu i tylko tam
się porównują. Na Linuksie (CI, chmura) testy wizualne są pomijane, bo inny
system rysuje czcionki inaczej i każdy ekran byłby „zmieniony”. Gdy dane konta dev zmienią
wygląd listy faktur (np. nowa faktura z długą nazwą nabywcy), odśwież
wzorzec listy.

Ten sam przebieg zbiera naruszenia dostępności axe (`serious`, `critical`):
załącznik `axe-<ekran>` w raporcie HTML i pliki
`test-results/wizualne-axe/<projekt>-<ekran>.json`. Na razie raport, nie
blokada.

## Mocki

Aktywowane przez env vars w `webServer.env` (playwright.config.ts):

| Flag | Co mockuje | Gdzie |
|---|---|---|
| `E2E_MOCK_ANTHROPIC=1` | Claude Vision OCR — deterministyczny stub paragonu Orlen | `lib/ocr/engine.ts` |
| `E2E_MOCK_RESEND=1` | Resend emails — log do stdout zamiast wysyłki | `lib/email/send.ts` (fail-soft gdy `RESEND_API_KEY` empty) |
| `E2E_MOCK_GUS=1` | GUS REGON BIR lookup — zawsze zwraca "E2E Mock Sp. z o.o." | `lib/gus/client.ts` |
| `E2E_MOCK_KSEF=1` | (zarezerwowany — KSeF używa real test env MF) | — |

Logika: `lib/test-mode.ts` ma helpers (`isAnthropicMocked()`, etc.).

## Struktura

```
e2e/
  README.md             # ten plik
  auth.setup.ts         # globalny setup — smoke check env vars + login form
  fixtures.ts           # rozszerzone Playwright `test()` z `seededUser`, `noOrgUser`, etc.
  helpers/
    auth.ts             # injectSupabaseSession() + loginViaUI()
    db-seed.ts          # admin client → tworzenie/usuwanie test users + tenants
    test-data.ts        # stałe (NIP, hasła, deterministic invoice numbers)
  pages/                # Page Object Model
    auth-page.ts
    onboarding-page.ts
  tests/                # właściwe scenariusze
    01-auth.spec.ts
    02-onboarding.spec.ts
    03-welcome-modal.spec.ts
    04-empty-states.spec.ts
    05-landing.spec.ts
```

## Konwencje

1. **Nie używaj `seededUser` w testach które testują samo seedowanie** — fixture
   tworzy fresh user per test, ale jeśli test ma sprawdzać "co jeśli user nie
   ma org" to weź `noOrgUser`.
2. **Selektory: w kolejności** `getByRole` → `getByLabel` → `data-testid` →
   raw `#id`. Unikamy CSS selectors bo zmiana stylów łamie testy.
3. **Polish copy** — używamy `getByText(/regex/i)` z `i` flag. Nie hardcoduj
   spacji nieprzełamywalnych albo polskich quotów.
4. **Cleanup** — fixture `seededUser` sam usuwa usera po teście. Jeśli test
   tworzy więcej rzeczy — `try { ... } finally { await cleanup(...) }`.
5. **Timeouts** — domyślny 60s na test (config), 10s na expect. Long-running
   operations (KSeF queue, Inngest jobs) — explicit `{ timeout: 30_000 }`.

## CI

`pnpm test:e2e` w `.github/workflows/ci.yml` jako osobny job — opt-in przez
`vars.RUN_E2E_ON_CI=true` w GitHub repo settings. Wymaga sekretów Supabase.
Sharding na 2 workers, artifacts (HTML report + screenshots) wgrywane przy
failures.

## Roadmap testów (Tier 1)

Status: 5/13 napisane (auth, onboarding, welcome modal, empty states, landing).

Pozostałe pakiety zaplanowane:
- ⬜ `06-invoice-create.spec.ts` — wystawienie zwykłej faktury → KSeF submit (test env)
- ⬜ `07-invoice-correction.spec.ts` — korekta CRP
- ⬜ `08-invoice-advance.spec.ts` — zaliczkowa + finalna
- ⬜ `09-offline24.spec.ts` — KSeF outage → Offline24 queue
- ⬜ `10-ocr-expense.spec.ts` — paragon → mock OCR → KPiR
- ⬜ `11-csv-import.spec.ts` — import Fakturownia/inFakt
- ⬜ `12-debt-reminders.spec.ts` — Wkurzacz Dłużników (mock Resend)
- ⬜ `13-accountant-copilot.spec.ts` — Co-Pilot księgowego

Tier 2 (deferred) — wymagają fazy 25 (Stripe) i 28 (RODO export):
- Trial → paid conversion
- Account deletion + data export
