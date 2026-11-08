# Centrum dowodzenia — błędy wysyłki do KSeF (`/admin/centrum/bledy`)

Dla operatora (człowieka) i dla sesji agentów AI. Widok tylko **czyta** —
stan faktur zmieniają akcje na karcie faktury (`/admin/ksef/<id>`) i RPC
opisane w `hamulce-ksef.md` oraz `ksef-error-codes.md`.

**Po co:** na fakturze zostaje tylko ostatni błąd (`invoices.last_error*`),
a każda kolejna próba go nadpisuje. Dziennik prób (`ksef_send_attempts`,
migracja 00150, na db-1 od 17.10.2026) ma wiersz na **każde** wykonanie joba
wysyłki i każdą odmowę przed kolejką. Dashboard pokazuje z niego, co się
psuje, ile razy i czy faktury potem przeszły.

## 1. Gdzie wejść

| Co | Adres |
|---|---|
| dashboard | `https://faktway.pl/admin/centrum/bledy` (stara domena `faktflow.pl` działa tak samo; adres aplikacji: `NEXT_PUBLIC_APP_URL`, `lib/site.ts`) |
| z menu | panel admina → „Błędy wysyłki” (`app/admin/_components/admin-nav.tsx`), kafelek na `/admin` |
| próby jednej faktury | `/admin/ksef/<id faktury>` → sekcja „Próby wysyłki (dziennik prób)” |
| lokalnie | `http://localhost:3000/admin/centrum/bledy` po `pnpm dev` — baza z `.env.local` to **inna** baza niż produkcja (AGENTS.md, pułapki), dane nie są produkcyjne; `ADMIN_EMAILS` trzeba mieć w `.env.local` |

## 2. Kto wejdzie — nie ma osobnego loginu ani hasła

Dostęp sprawdza `requireAdmin()` (`lib/auth/admin-guard.ts`) przy każdym
wejściu. Logujesz się **własnym kontem aplikacji** (`/login`). Wszystkie
warunki naraz:

| Warunek | Gdy nie jest spełniony |
|---|---|
| zalogowany | przekierowanie na `/login?error=admin_required` |
| e-mail konta potwierdzony | przekierowanie na `/dashboard` |
| e-mail konta na liście `ADMIN_EMAILS` (zmienna środowiska aplikacji, adresy po przecinku, wielkość liter bez znaczenia; **pusta lista = nikt**) | przekierowanie na `/dashboard` — tak wygląda brak uprawnień |
| włączone 2FA (TOTP, aplikacja uwierzytelniająca) | brak: `/login/two-factor/setup`; sesja bez kodu: `/login/two-factor` |

Zasady, bo repozytorium jest publiczne:

- **żadnych haseł, kodów 2FA ani adresów e-mail z `ADMIN_EMAILS` w repo,
  opisach PR i komentarzach**;
- `ADMIN_EMAILS` na produkcji ustawia się w Coolify (aplikacja `id=1`,
  zmienna z `is_preview = false`). Zmiana wymaga restartu aplikacji, więc to
  wdrożenie — tylko Bartosz albo na jego wyraźne polecenie (AGENTS.md,
  zasady twarde). Nowy operator prosi Bartosza o dopisanie swojego adresu.

## 3. Agent AI — jak „widzi” ten dashboard

Agent **nie loguje się** do panelu (nie ma konta, 2FA ani zgody na
wpisywanie haseł). Te same dane i progi ma bez przeglądarki:

| Potrzeba | Droga |
|---|---|
| liczby i listy z produkcji | `./scripts/ops/kontrola-faktur-ksef.sh` (sesja lokalna z `.agents/infra.env`) — sekcja 12 „dziennik prób wysyłki” liczy tak samo jak dashboard (te same progi; sekcja wchodzi z wydaniem A5, #257) |
| jedna faktura | SELECT na `ksef_send_attempts` po `invoice_id` (tylko odczyt, procedura z AGENTS.md) |
| logika widoku | kod w punkcie 7 — progi i grupowanie są w czystym module `send-errors.ts` |

## 4. Sekcje strony (od góry)

„w `main`” = jest na `main` od #250 (13.10.2026); „#257” = wchodzi
z wydaniem A5 (#257–#263, czeka na scalenie).

| Sekcja | Co pokazuje | Źródło | Gdzie |
|---|---|---|---|
| **Odczyt niepełny** (czerwona ramka) | któreś zapytanie padło — liczby mogą zaniżać błędy; nigdy pusta zielona lista przy awarii odczytu | każdy odczyt | w `main` |
| **Czy worker działa** | ostatni przebieg 3 cronów i termin: puls workera 2 min, monitor alarmów 10 min, strażnik cyklu życia 30 min; po terminie — „worker mógł stanąć”, przebieg z błędem — „cron nie robi swojej pracy”; od kiedy jest dziennik; ile faktur wychodzących ma błąd teraz | `inngest_run_log`, `invoices` | w `main` |
| **Utknięte w wysyłce teraz** | I1 (`queued` > 15 min bez zlecenia w pg-boss) i I2 (`sending` > 30 min albo bez znacznika przejęcia) — niezależnie od filtrów; I1 > 45 min = „Automat nie zadziałał”; kolumna „Co dalej” | RPC `ksef_lifecycle_violations()` (00148) | #257 |
| **Filtry** | okres 24h / 7d (domyślnie) / 30d, rodzaj, klasa, etap, kod; w adresie strony (link da się przekazać); nieznana wartość wraca do domyślnej | adres strony | w `main` |
| **Liczniki** | błędy wykonania, przerwane, odmowy przed kolejką, oczekiwania, udane, % wykonań z błędem (informacyjnie) | dziennik, liczone w bazie | w `main` |
| **Incydenty** | wiersze zgrupowane po odcisku (punkt 5); wystąpienia, faktury i firmy, pierwsze → ostatnie, **stan teraz** dotkniętych faktur, przykład z linkiem do karty | dziennik + `invoices` | w `main` |
| **Próby** | pojedyncze wiersze, najnowsze na górze: faktura (stan teraz), rodzaj, etap, kod i HTTP, numer wykonania, komunikat, wersja workera (SHA) | dziennik | w `main` |
| **UPO nieudane teraz** | pobranie UPO `failed` albo `pending` ponad godzinę — niezależnie od okresu | `upo_receipts` | w `main` |

Odmowy operatora z `/admin/ksef` („Wyślij ponownie”, „Tylko uzgodnij”)
trafiają do dziennika jako `refused` od #257 (#252).

## 5. Pojęcia

| Pojęcie | Znaczenie |
|---|---|
| wiersz dziennika | jedno wykonanie joba wysyłki (job pg-boss). Ponowienie = nowy wiersz, więc błąd sprzed sukcesu zostaje w historii |
| statusy | `started` (w toku), `succeeded`, `failed`, `waiting` (job odłożony bez zużycia próby — `RetryAfterError` z `countsAsAttempt: false`, w budżecie odczekań; po limicie liczy się jako błąd), `refused` (odmowa przed kolejką: hamulec, MFA, certyfikat, KSeF niedostępny) |
| **przerwane** | `started` bez wyniku ponad 20 min — worker padł w trakcie (wdrożenie, OOM) albo nie udał się zapis wyniku do dziennika; to błąd, choć nikt nie zapisał jego kodu |
| klasa | `terminal` (treść), `transient` (przejściowy), `hold` (hamulec), `reconcile` (uzgodnienie), `setup` (ustawienia) — katalog `lib/ksef/send-error-classes.ts`, opis kodów `ksef-error-codes.md` |
| etap | gdzie padło: zdarzenie, stan i hamulce, Offline24, poświadczenia, sonda KSeF, przejęcie, uzgodnienie, wysyłka, XML, odpowiedź KSeF, zapis numeru, po przyjęciu, przed kolejką |
| **odcisk** | status + kod + etap + HTTP + kod KSeF + szablon komunikatu (UUID, numery KSeF, referencje i liczby zamienione na symbole) — ten sam błąd na 50 fakturach to jeden incydent |
| **stan teraz** | bieżący stan dotkniętych faktur, każda liczona raz: przyjęte / nadal z błędem / utknęła (operator) / w toku / szkic / nieznany |
| fail-open | zapis dziennika nigdy nie zatrzymuje wysyłki (limit 3 s); nieudany zapis = ostrzeżenie w logu i Sentry „dziennik prób wysyłki — zapis nieudany” |

## 6. Co robić, gdy…

| Widzisz | Znaczy | Zrób |
|---|---|---|
| „Czy worker działa” na żółto (po terminie) | worker mógł stanąć — pusta lista błędów nic wtedy nie znaczy | logi workera (AGENTS.md, `docker logs`), `/admin/system`, `joby-pg-boss.md` |
| incydent przejściowy, stan teraz „przyjęte” | błąd był, automat go odzyskał | nic; przy dużej liczbie — czy KSeF nie miał awarii |
| „nadal z błędem” | faktura `failed`/`rejected` | karta faktury `/admin/ksef/<id>`; wyjście według kodu: `ksef-error-codes.md` |
| „przerwane” albo „utknęła” | worker padł w trakcie wysyłki | stan faktury na karcie; `sending` ponad 30 min = I2 → `hamulce-ksef.md`, „Faktura utknęła w wysyłce (I1/I2)” (procedura `scripts/ops/zwolnij-utknieta-wysylke.sh` wchodzi z #260) |
| dużo „odmów przed kolejką” | hamulec, MFA, certyfikat albo KSeF niedostępny przy kliknięciu „Wyślij” | kod odmowy; hamulce: `hamulce-ksef.md` |
| UPO `pending` ponad godzinę | pobranie albo zapis UPO nie skończył się | karta faktury; cron `upo-retry-stale` ponawia |
| „Odczyt niepełny: … ksef_send_attempts …” | tabela niewidoczna dla PostgREST | czy 00150 jest w `schema_migrations`, `NOTIFY pgrst, 'reload schema'` (AGENTS.md, wgrywanie migracji) |
| kolumna „Worker” pusta | worker bez `SOURCE_COMMIT` w środowisku | zgłoś Bartoszowi (zmienna w Coolify, aplikacja `id=2`) |

## 7. Czego dashboard nie pokazuje

| Brak | Gdzie zamiast |
|---|---|
| decyzje crona cyklu życia bez joba wysyłki: `ENQUEUE_LOST`, `TRANSIENT_EXHAUSTED` | `/admin/ksef` (lista `failed` wg kodu); audyt tych przejść — luka #1 (migracja) |
| faktury w `offline_queued` | sekcja 4a skryptu kontroli, `offline24-zalegle.md` (od #257); luka #5 |
| próby sprzed dziennika (przed wdrożeniem 00150 i workera z #249) | tylko ostatni błąd na fakturze |
| alarmy | monitor alarmów, Sentry, Telegram — dashboard nic nie wysyła |

## 8. Gdzie w kodzie

| Warstwa | Plik |
|---|---|
| zapis dziennika (worker, odmowy przed kolejką) | `lib/ksef/send-attempt-ledger.ts` (`withSendAttemptLedger`, `recordSendRefusal`); podpięcie: `lib/jobs/handlers/package-d.ts` |
| tabela | `supabase/migrations/00150_*.sql` — RLS bez polityk, zapis tylko `service_role`, bez DELETE |
| odczyt (zapytania) | `lib/admin/centrum/attempts.ts` (`loadSendErrorsView`, `listInvoiceAttempts`) |
| czysta logika (progi, odcisk, incydenty, świeżość cronów) | `lib/admin/centrum/send-errors.ts` |
| strona | `app/admin/centrum/bledy/page.tsx` (Server Component, `requireAdmin()`) |
| dostęp | `lib/auth/admin-guard.ts` |
| testy | `tests/unit/centrum-bledy-wysylki.test.ts`, `tests/rls-dziennik-prob-wysylki.test.ts` |
| projekt | `docs/koordynacja/CENTRUM-DOWODZENIA-BRIEF-DLA-CODEXA.md` (C-22), `PLAN-ZERO-ZGUBIONYCH-FAKTUR.md` (A5) |
