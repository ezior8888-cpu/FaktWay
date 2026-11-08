# Projekt: prawdziwe usuwanie firmy (organizacji)

> **Dla Bartosza, do decyzji.** Ten dokument nie zmienia kodu ani bazy. Szkice
> SQL są blokami w tekście, nie plikami w `supabase/migrations/`; migracje
> pisze i wgrywa wyłącznie Bartosz.
>
> Stan sprawdzony 15.10.2026 na `origin/main` 1ded2147 oraz na gałęziach
> #264 (`claude/prawne-dokumenty-i-zgody`, 6f37fa78 — terminy kopii zgodne z kodem) i #271
> (`claude/usun-firme-blokada`). Każde twierdzenie ma plik:linia — sprawdzaj
> w kodzie, nie w tym pliku.
>
> **Zastępuje projekt z #272** (`docs/koordynacja/PROJEKT-USUWANIE-FIRMY.md`).
> Przejmuje jego ustalenia, poprawia jedno błędne (§ 12) i dodaje brakujące:
> strażnika faktur, który blokuje każdą rolę, oraz kolejkę Offline24.

## Spis treści

0. W skrócie
1. Co obiecujemy w dokumentach i oś czasu
2. Stan dziś
3. Model: stany firmy i rejestr zamknięć
4. Ustalenie 1 — wyłączenie dostępu (RLS, aplikacja, joby, członkowie, księgowe)
5. Ustalenie 2 — Stripe
6. Ustalenie 3 — twarde usunięcie mimo strażników
7. Ustalenie 4 — ścieżka operatora (dziś i docelowo) i potwierdzenie dla klienta
8. Ustalenie 5 — job usuwający: idempotencja i ponowienie od zera
9. Szkic SQL
10. Testy, które muszą powstać
11. Kolejność prac
12. Poprawki względem #272
13. Decyzje dla Bartosza

---

## 0. W skrócie

| | |
|---|---|
| **Dziś** | Aplikacja nie umie wyłączyć ani usunąć firmy. Flag `tenants.deleted_at`, `hard_delete_at` i `is_active` nikt nie czyta przy dostępie. Od #271 zlecenie idzie mailem do pomocy, a operator nie ma narzędzia. |
| **Najważniejsza przeszkoda** | Wysłanej do KSeF faktury nie usunie **żadna** rola, także właściciel bazy (`b_guard_invoice_pending_content`, 00132:63-72). Bez migracji nie da się więc dotrzymać umowy powierzenia § 9 — także ręcznie. |
| **Zegar** | Pierwszy mail z wypowiedzeniem uruchamia termin: 30 dni na eksport + 30 dni na usunięcie. Mechanizm z tego projektu (co najmniej M1–M4) musi być na produkcji **w ciągu 60 dni od pierwszego zlecenia**. Do tego czasu odcięcie dostępu da się zrobić ręcznie, bez migracji (§ 7.1). |
| **Propozycja** | Cztery stany firmy: `active` → `closing` (30 dni, dostęp jest) → `locked` (dostęp odcięty) → `purged`. Firmy **nie kasujemy** wierszem `DELETE FROM tenants`: usuwamy dane klienta tabela po tabeli funkcją `purge_tenant_data()`, a wiersz firmy zostaje jako zanonimizowany **nagrobek** (tombstone — pusty wiersz z samym identyfikatorem). Dzięki temu zostają nasze zapisy rozliczeń ze Stripe. |
| **Wymaga migracji** | M1 stan i rejestr zamknięć, M2 helpery RLS, M3 furtka w strażniku faktur, M4 funkcja usuwająca, M5 przejścia stanów. Wszystkie addytywne, wgrywane przed wdrożeniem kodu. |
| **Znalezione przy okazji** | (1) `DELETE FROM tenants` wywróci się na strażnikach i kluczach `RESTRICT`, a gdyby przeszedł, skasowałby nasze zapisy finansowe (§ 6.1). (2) Kopie zapasowe: #264 dopasował umowę do kodu (cykl ≤ 60 dni), ale kopii ręcznych job nie usuwa wcale, a kopia poza serwerem (Storage Box) nie ma jeszcze retencji (§ 6.6). (3) Panel admina przy usuwaniu **konta** ustawia flagi **firmy** — po włączeniu flag zamknąłby firmę wszystkim członkom (§ 2.2). (4) Firmy oflagowane starą akcją: po włączeniu sprawdzania flag automat mógłby je od razu usunąć (§ 2.3). |

---

## 1. Co obiecujemy w dokumentach i oś czasu

Teksty z #264 (gałąź `claude/prawne-dokumenty-i-zgody`):

| Źródło | Treść (skrót) |
|---|---|
| Regulamin § 14 ust. 2 (`lib/legal/documents/regulamin.ts:249`) | Klient wypowiada Umowę e-mailem, „w tym zlecając usunięcie Organizacji”. Możemy poprosić o potwierdzenie, że pisze klient. Usunięcie Konta nie rozwiązuje Umowy. |
| Regulamin § 14 ust. 3–5 (`regulamin.ts:250-263`) | My wypowiadamy z 30-dniowym okresem (ust. 3) albo natychmiast przy naruszeniach (ust. 4), e-mailem z uzasadnieniem. |
| Regulamin § 14 ust. 6 (`regulamin.ts:264`) | Po rozwiązaniu 30 dni na eksport, Organizacja **pozostaje dostępna**, chyba że klient zleci wcześniejsze usunięcie. **Informujemy e-mailem o planowanym usunięciu.** Konta Użytkowników zostają aktywne. |
| Regulamin § 6 (`regulamin.ts:137`) | Bez zwrotu za rozpoczęty okres przy wypowiedzeniu przez klienta; zwrot za niewykorzystaną część przy naszym wypowiedzeniu z § 14 ust. 3, reklamacji, odstąpieniu i zmianie regulaminu. |
| Regulamin § 7 (`regulamin.ts:149`) | Obowiązek przechowywania faktur ciąży na kliencie; faktury z KSeF przechowuje też KSeF. |
| Umowa powierzenia § 9 (`lib/legal/documents/umowa-powierzenia.ts:129-136`, wersja 6f37fa78) | 30 dni na eksport (na żądanie przekazujemy dane w formacie eksportu); potem usunięcie **w ciągu kolejnych 30 dni**; kopie zapasowe w cyklu nadpisywania **nie dłuższym niż 60 dni** (dzienne do 30 dni, tygodniowe do 8 tygodni); **kopie ręczne usuwamy w tym samym terminie**; przy awarii tworzenia kopii ostatnie poprawne zostają do czasu nowych; kopie służą tylko do odtworzenia po awarii; **na żądanie potwierdzamy usunięcie**; klient może polecić wcześniejsze usunięcie e-mailem. |

Oś czasu (T0 = skuteczne rozwiązanie Umowy):

```
T0 ─────────── T0+30 dni ─────────────────── T0+60 dni ─────────── T0+120 dni
│  closing:     │  locked: dostęp odcięty,    │ najpóźniej tu dane   │ najpóźniej tu
│  dostęp jest, │  job usuwa (zwykle tej      │ usunięte (purged)    │ znikają z kopii
│  eksport      │  samej nocy)                │                      │ (cykl ≤ 60 dni)
└ mail: „usuniemy dane po <data>”             └ mail: potwierdzenie usunięcia
```

Przy wcześniejszym usunięciu na polecenie klienta `closing` trwa 0 dni (albo krótką karencję, D-11):
od razu `locked`, a 30 dni na usunięcie liczy się od polecenia.

---

## 2. Stan dziś

### 2.1 Kto czyta flagi firmy

| Miejsce | Czyta `is_active` / `deleted_at` / `hard_delete_at`? |
|---|---|
| `is_member_of()` (00037:25-39), `has_org_role()` (00037:45-60), `get_current_tenant_id()` (00037:68-108), `shares_active_org_with()` (00058:30-48) — podstawa RLS | **nie**, tylko `memberships.status = 'active'` |
| `requireUserAndActiveOrg` (`lib/supabase/auth-context.ts:77-83`), `resolveApiUserAndActiveOrg` (`auth-context.ts:153-160`), `getPageContext` (`lib/supabase/page-context.ts:41-49`) | **nie**, klient admina i `memberships.status` |
| przełącznik firm i bramka layoutu (`lib/dashboard-shell-data.ts:49-59`, `:111-127`) | **nie** |
| joby (`lib/jobs/runners/**`), w tym `requireTenantMember` (`lib/jobs/runners/tenant-boundary.ts:43-51`) | **nie** — żaden |
| `inbox-polling` (`lib/jobs/runners/inbox-polling.ts:136-145`) | **nie**, choć komentarz w 00004:20-22 mówi, że `is_active` dodano właśnie „do filtra” tego joba |
| portal księgowej: `lib/accountant/load-accountant-portal.ts:49-58`, `app/accountant/[token]/download/[invoiceId]/route.ts:24-31`, `app/api/portal/exports/generate/route.ts:47-51` | **nie** — tylko `revoked_at` i `expires_at` linku |
| `cron.retention-delete` (`lib/jobs/runners/retention-delete.ts:26-40`) | **nie** — usuwa tylko **faktury** po `invoices.scheduled_deletion_at` (retencja 10 lat). Komentarz w `app/admin/users/actions.ts` („pełne czyszczenie zrobi job `retention-delete`”) był nieprawdziwy — usunięty razem z blokiem z § 2.2 (gałąź `claude/admin-bez-flag-firm`, 22.10.2026). |
| `lib/flo/tick.ts:298-310` | tak (`is_active` i `deleted_at`) |
| `lib/analytics/platform-metrics.ts:71-75`, `lib/admin/flags.ts:59`, `mv_tenant_dashboard_summary` (00044:160) | tak — liczniki i widoki |
| Stripe | nikt nie anuluje subskrypcji z serwera; jedyna droga to portal klienta (`lib/stripe/portal.ts:38`) |
| bramka funkcji po wygaśnięciu subskrypcji | brak — tabelę `subscriptions` czyta 6 plików, żaden w ścieżce dostępu |

### 2.2 Kto dziś ustawia flagi

| Miejsce | Co robi | Problem po włączeniu sprawdzania flag |
|---|---|---|
| `requestAccountDeletionAction` (dawniej `components/settings/account-actions.ts:58-65`) | stawiała `deleted_at`, `hard_delete_at = +30 dni`, `is_active = false` klientem użytkownika | #271 to wyłączył, a 22.10.2026 akcję i formularz usunięto (ekran to instrukcja z linkiem do pomocy, `components/settings/company-deletion.tsx`); po M1 strażnik kolumn (§ 9 M1) i tak zabroni klientowi pisać te pola |
| `deleteUserGdprAction` (`app/admin/users/actions.ts:149-180`) | przy usuwaniu **konta** stawia flagi na **każdej firmie**, gdzie usuwany jest właścicielem | po włączeniu flag usunięcie jednego konta zamknęłoby firmę wszystkim członkom, wbrew regulaminowi § 14 ust. 2 („usunięcie Konta nie rozwiązuje Umowy”). **Ten blok musi zniknąć przed M2.** Zrobione 22.10.2026 (gałąź `claude/admin-bez-flag-firm`): panel usuwa konto, firm nie rusza, a w komunikacie i audycie (`ownedOrgsLeftActive`) podaje, ile firm działa dalej. |

### 2.3 Firmy oflagowane starą akcją

Przycisk „Usuń konto” działał do #271, więc na produkcji mogą być firmy
z `deleted_at`/`hard_delete_at` z przeszłości, z których ludzie **dalej
korzystają**. Termin `hard_delete_at` mógł minąć. Dlatego:

- automat z tego projektu **nie czyta starych flag** — usuwa wyłącznie firmy
  ze wpisem w nowym rejestrze `tenant_closures` (§ 3.2), założonym przez
  operatora;
- M1 ustawia wszystkim firmom `lifecycle_state = 'active'`, więc wgranie
  niczego nikomu nie odetnie;
- co z oflagowanymi — decyzja D-9 (§ 13). Zapytanie (tylko odczyt) w § 9.0.

---

## 3. Model: stany firmy i rejestr zamknięć

### 3.1 Stany

```
           operator: rozwiązanie         cron: export_until minął        job: dane usunięte
 active ─────────────────────────► closing ──────────────────────► locked ─────────────────► purged
   ▲                                  │      (albo operator: polecenie      (wiersz firmy =
   └──── operator: cofnięcie ─────────┘       wcześniejszego usunięcia)       nagrobek)
         (tylko przed export_until)
```

| Stan | Członkowie i księgowe | Joby z efektem zewnętrznym | Stripe | KSeF | Dane |
|---|---|---|---|---|---|
| `active` | pełny dostęp | działają | aktywna | działa | są |
| `closing` (T0 … `export_until`) | dostęp i eksport (D-2: pełny czy tylko odczyt) | stop, **poza dokończeniem wysyłek do KSeF** (§ 4.4) | `cancel_at_period_end` (§ 5) | nowe wysyłki z UI — D-2; kolejka Offline24 i UPO kończą się | są |
| `locked` | brak (RLS, aplikacja, portal) | stop | — | dane uwierzytelniające skasowane | job usuwa |
| `purged` | brak | — | **nasze** zapisy płatności zostają | — | nagrobek: `id`, stan, daty; bez nazwy, adresu, certyfikatu |

### 3.2 Gdzie trzymać stan (decyzja D-1)

Polecam **nową kolumnę `tenants.lifecycle_state` + tabelę `tenant_closures`**:

- `lifecycle_state` — jedno pole, które czytają helpery RLS i aplikacja.
  Nie da się go pomylić z `is_active`, które Flo i widoki czytają w innym
  sensie.
- `tenant_closures` — rejestr zamknięć: kto zlecił, jak operator sprawdził
  nadawcę, daty, wynik Stripe, liczniki usuniętych wierszy i plików, kiedy
  wysłano maile. Przeżywa usunięcie danych i jest **dowodem usunięcia**
  (potwierdzenie z umowy § 9). Wiersz firmy zostaje jako nagrobek, więc
  klucz obcy nie znika.
- Stare kolumny dostają jasne znaczenie: `deleted_at` = T0, `hard_delete_at`
  = ostateczny termin usunięcia (T0 + 60 dni albo polecenie + 30 dni),
  `is_active = false` od `closing` (Flo i widoki przestają liczyć firmę).

Alternatywa (D-1b): same stare kolumny z nowym znaczeniem. Mniej migracji,
ale brak miejsca na dowód usunięcia i ryzyko ze starymi flagami z § 2.3.

---

## 4. Ustalenie 1 — wyłączenie dostępu

### 4.1 RLS i helpery (migracja M2)

Wszystkie polityki postaci `tenant_id = public.get_current_tenant_id()`
przechodzą przez `is_member_of()` (00037:102). Wystarczy więc zmienić
**cztery funkcje**, nie dziesiątki polityk:

| Funkcja | Zmiana |
|---|---|
| `is_member_of(p_org)` (00037:25-39) | członkostwo aktywne **i** firma w `active`/`closing` |
| `has_org_role(p_org, p_role)` (00037:45-60) | jw. |
| `shares_active_org_with(p_user)` (00058:30-48) | wspólna firma w `active`/`closing` |
| `get_current_tenant_id()` (00037:68-108) | bez zmian — woła `is_member_of` |

Skutek w `locked`: `get_current_tenant_id()` zwraca NULL, każda polityka
odcina. Realtime Supabase też idzie przez RLS. Szkic w § 9 M2.

Pola stanu muszą być chronione przed klientem: polityka
`tenants_update_own_owner` (00037:121-128) pozwala właścicielowi na UPDATE
całego wiersza, a odebranie uprawnienia do kolumny nie działa przy
uprawnieniu do tabeli (komentarz w 00079:63-65). Potrzebny strażnik kolumn
(§ 9 M1) — inaczej właściciel zamkniętej firmy ustawiłby sobie
`lifecycle_state = 'active'` przez PostgREST.

### 4.2 Aplikacja (klient admina omija RLS)

144 pliki w `app/` i `lib/` używają `createAdminClient()`, więc sam RLS nie
wystarczy. Wejścia są jednak trzy i wszystkie czytają `memberships`:

| Miejsce | Zmiana |
|---|---|
| `auth-context.ts:77-83` i `:153-160` | dołączyć `tenants!inner(lifecycle_state)` i odrzucić `locked`/`purged` tym samym komunikatem co brak członkostwa; zwrócić `lifecycleState` w kontekście (baner, D-2) |
| `page-context.ts:41-49` | jw. → `redirect('/onboarding')` |
| `dashboard-shell-data.ts:49-59` | firmy `locked`/`purged` znikają z przełącznika; `closing` dostaje baner z datą `export_until` i linkiem do eksportu |
| `tenant-boundary.ts:43-51` (`requireTenantMember` w jobach) | jw. |

Jeden helper `lib/tenants/lifecycle.ts` (stałe stanów, `assertTenantOperational`)
zamiast powielania warunku.

### 4.3 Członkowie i księgowe

| Kto | `closing` | `locked` / `purged` |
|---|---|---|
| właściciel | dostęp (D-2), baner, mail o planowanym usunięciu | firma znika z listy; konto zostaje (§ 14 ust. 6) |
| pozostali członkowie (`admin`, `member`, `accountant` w `memberships`) | jw. + **mail informacyjny** (polecam — tracą dostęp do danych, z którymi pracują) | jw.; kto nie ma innej firmy, ląduje na `/onboarding` (`page-context.ts:49`) i może założyć nową |
| księgowa z linkiem portalu (`accountant_access`) | odczyt zostaje albo odwołanie — D-3 (polecam: zostaje, to też eksport) | `revoked_at = now()` przy przejściu; trzy wejścia z tokenem (§ 2.1) sprawdzają stan firmy |
| Co-Pilot (`accountant_settings.co_pilot_enabled`) | wyłączyć przy przejściu do `closing` | — |
| zaproszenia i prośby o dołączenie (`organization_invitations`, `organization_join_requests`) | odwołać przy przejściu; akceptacja zaproszenia sprawdza stan firmy | usunięte przez `purge_tenant_data` |

Członkostwa **nie zmieniamy** na `suspended` w docelowym mechanizmie: stan
firmy wystarcza, a cofnięcie zamknięcia nie musi odtwarzać ról. (Ręcznie,
do czasu migracji, `suspended` jest właśnie dźwignią — § 7.1.)

### 4.4 Joby

27 cronów (`lib/jobs/handlers/*`). Zasada: w `closing` i `locked` stop
wszystkiego, co wychodzi na zewnątrz, **oprócz dokończenia wysyłek do KSeF** —
faktury wystawione w trybie Offline24 klient musi dosłać do KSeF w terminie
ustawowym, a UPO to jego dowód. Wyłączenie tej kolejki przy wypowiedzeniu
narażałoby klienta na naruszenie przepisów.

| Cron | Wybiera firmy przez | Efekt zewnętrzny | `closing` | `locked` |
|---|---|---|---|---|
| `process-offline-queue` | faktury w kolejce offline | **wysyłka do KSeF** | **dokończyć** | pominąć (przejście do `locked` czeka, § 4.5) |
| `ksef-lifecycle-reconcile`, `upo-retry-stale` | faktury w toku | KSeF | **dokończyć** | pominąć |
| `inbox-polling` (`inbox-polling.ts:136-145`), `inbox-backfill` | dane uwierzytelniające KSeF | KSeF | pominąć | pominąć (i tak brak danych) |
| `reminder-scheduler` (`reminder-scheduler.ts:146-152`) | `reminder_settings.enabled` | **maile do kontrahentów** | pominąć | pominąć |
| `co-pilot-monthly` (`co-pilot-monthly.ts:154-158`) | `co_pilot_enabled` | **maile do księgowej** | pominąć | pominąć |
| `cert-expiry-alert` (`cert-expiry-alert.ts:75`), `daily-summary-email`, `weekly-business-review`, `trial-countdown-emails` | firmy / subskrypcje | maile, push | pominąć | pominąć |
| `nightly-validation-recheck`, `archive-old-invoices` | kontrahenci, faktury | GUS, Glacier | pominąć | pominąć |
| `flo-tick` (`lib/flo/tick.ts:305-306`) | `is_active` i `deleted_at` | — | pomija już dziś (`is_active = false` od `closing`) | jw. |
| `retention-delete`, `cleanup-*`, `daily-db-snapshot`, `verify-backup`, `ksef-health-check`, `jobs-watchdog`, `critical-alerts-monitor`, `daily-analytics-digest`, `ksef-lifecycle-report`, `gdpr-process-deletions`, `ops-heartbeat`, `flo-shadow-settle` | operacyjne | wewnętrzne | bez zmian | bez zmian |

Joby zdarzeniowe (`submit-invoice`, `notify-user`, `send-reminder`,
`process-ocr`, `bulk-import`, `exports-generate`, `magic-import-ksef`,
`download-upo`, `dunning-payment-failed`, …): już zakolejkowane sprawdzają
stan na starcie przez `assertTenantOperational(tenantId, cel)` i kończą się
`NonRetriableError`. Wyjątek: `submit-invoice` i `download-upo` w `closing`
(dokończenie KSeF). Eksport (`exports-generate`) działa w `closing` — to
cel tego okresu.

Strażnik testowy: test, że **każdy** cron z rejestru jest na liście
„sprawdza stan” albo „operacyjny”. Nowy cron nie przejdzie CI bez decyzji.

### 4.5 Faktury w drodze przy przejściu do `locked`

Przejście `closing → locked` (§ 9 M5) **odmawia**, dopóki firma ma faktury
w `queued` / `offline_queued` / `sending` albo wpisy w `ksef_offline_queue`
bez wyniku. To blokada z wyjściem (protokół, pkt 4):

- operator dostaje alarm z listą faktur (`critical-alerts-monitor`);
- wyjście: procedura dla faktur utkniętych w wysyłce (#260) albo decyzja
  operatora; zapas 30 dni do `hard_delete_at` daje czas;
- alarm eskaluje 7 dni przed `hard_delete_at`.

Brak UPO **nie blokuje** przejścia — UPO można pobrać z KSeF.

---

## 5. Ustalenie 2 — Stripe

| Sytuacja | Co robimy | Skąd |
|---|---|---|
| Klient wypowiada (§ 14 ust. 2) | `subscriptions.update(id, { cancel_at_period_end: true })` z serwera, z kluczem idempotencji `closure-<id>-cancel`; bez zwrotu | regulamin § 6 |
| My wypowiadamy z 30-dniowym okresem (§ 14 ust. 3) | jw. na koniec okresu; zwrot za niewykorzystaną część — istniejąca ścieżka zwrotów (`lib/billing/refund-operations.ts`) | regulamin § 6 |
| My wypowiadamy natychmiast (§ 14 ust. 4) | `subscriptions.cancel(id, { prorate: false })` | — |
| Wcześniejsze usunięcie na polecenie klienta | jak przy wypowiedzeniu klienta | — |

Uwagi:

- Dziś nie ma kodu, który anuluje subskrypcję z serwera — tylko portal
  (`lib/stripe/portal.ts:38`). Potrzebna funkcja w `lib/stripe/subscription.ts`.
  Webhook `customer.subscription.deleted` już ustawia `status = 'canceled'`
  (`lib/stripe/webhook-handlers.ts:115`).
- Wynik zapisujemy w `tenant_closures.stripe_cancel_requested_at`.
  Błąd Stripe **nie blokuje** zamknięcia, ale zostawia alarm dla operatora —
  inaczej awaria Stripe trzymałaby klienta w umowie.
- `dunning-payment-failed` w `closing` nie wysyła wezwań.
- **Klienta Stripe (Customer) nie usuwamy**, a nasze tabele rozliczeń
  zostają: to nasza dokumentacja sprzedaży, którą przechowujemy z własnego
  obowiązku podatkowego (RODO art. 6 ust. 1 lit. c), nie dane powierzone.
  Okres przechowywania — D-6.

---

## 6. Ustalenie 3 — twarde usunięcie mimo strażników

### 6.1 Dlaczego nie `DELETE FROM tenants`

Większość tabel ma `tenant_id … ON DELETE CASCADE`, więc kusi jeden DELETE.
Ten DELETE dziś się wywróci, a gdyby przeszedł, zrobiłby szkodę:

| # | Co | Skutek |
|---|---|---|
| a | `audit_logs.tenant_id … ON DELETE CASCADE` (00008:17-21) + `trg_audit_logs_prevent_delete` (00052:37-41) | kaskada to DELETE na `audit_logs`, strażnik odrzuca bez `SET LOCAL app.allow_audit_purge = 'true'` → wywraca całość |
| b | `b_guard_invoice_pending_content` (trigger 00119:108-111, funkcja 00132:37, gałąź DELETE 00132:63-72) | wysłanej faktury (`submitted_to_ksef_at`, `offline_idempotency_key`, `queued`/`sending`) nie usuwa **żadna** rola, także `postgres` → wywraca całość |
| c | `stripe_financial_cases → stripe_payments (tenant_id, id) ON DELETE RESTRICT` (00080:47-49) i dalsze RESTRICT (00080:60, :88, :998) | kaskada na `stripe_payments` odbija się od sprawy finansowej → wywraca całość |
| d | `prevent_financial_case_review_mutation` (00080:1018-1036) | historia przeglądów spraw finansowych jest tylko do dopisywania, bez furtki |
| e | billing: `subscriptions` (00047:70), `stripe_payments` (00047:142), `stripe_refunds` (00047:202), `stripe_refund_operations` (00075:30), `billing_notifications` (00048:25), `stripe_checkout_attempts` (00081:22), `stripe_customer_attempts` (00114:22) — wszystkie `ON DELETE CASCADE` | gdyby (a)–(d) nie zatrzymały kaskady, skasowałaby **nasze** zapisy sprzedaży i zwrotów |

Dlatego projekt **nie usuwa wiersza `tenants`**. Funkcja `purge_tenant_data()`
usuwa dane klienta jawnie, tabela po tabeli, a wiersz firmy anonimizuje
(nagrobek). Tabele rozliczeń dalej wskazują na nagrobek — bez zmiany kluczy
obcych w tabelach z ciężkimi strażnikami (00077, 00080). To główna różnica
względem #272, który proponował przepięcie kluczy billingu na `SET NULL`.

### 6.2 Strażnicy, przez których przechodzi usuwanie

Funkcja `purge_tenant_data()` jest `SECURITY DEFINER` z właścicielem
`postgres` (migracje wgrywa się `psql -U postgres`). Wewnątrz niej
`current_user = 'postgres'`, a wyzwalacze `SECURITY INVOKER` dziedziczą tę
rolę. Większość strażników przepuszcza role spoza API:

| Strażnik | Tabela | Rola `postgres` | Co trzeba |
|---|---|---|---|
| `b_guard_invoice_pending_content` (00132:63-72) | `invoices` | **blokuje** | **M3**: furtka tylko dla `postgres` z flagą sesji równą `tenant_id` (§ 9 M3) |
| `a_guard_invoice_delivery_history` (00132:137, wyjście 00132:147) | `invoices` | przepuszcza | — |
| `c_guard_ksef_retired_draft_delete` (00148:614, wyjście 00148:629-632) | `invoices` | przepuszcza | — |
| `a_guard_billing_invoice_identity` (00079:67-84) | `invoices` | przepuszcza; dotyczy tylko faktur z `stripe_invoice_id`, czyli faktur **operatora**, nie klienta | — |
| `guard_historical_ksef_invoice_lines` (00132:239, wyjście 00132:251), `guard_accepted_ksef_invoice_line` (00117:181-190), `a_guard_billing_invoice_line` (00079:149-187) | `invoice_line_items` | przepuszczają | — |
| `b_guard_pending_invoice_lines` (00119:116-162) | `invoice_line_items` | **blokuje każdą rolę**, gdy rodzic jest wysłany… | …ale przy kaskadzie z `invoices` rodzica już nie ma (pętla nic nie znajduje). Pozycje usuwamy **wyłącznie kaskadą** z faktury, nigdy bezpośrednio. Do potwierdzenia testem (§ 10, T3). |
| `guard_ksef_expense_provenance` (00128:24-41) | `expenses` | przepuszcza | — |
| `trg_audit_logs_prevent_delete` (00052:16-41) | `audit_logs` | **blokuje** | `SET LOCAL app.allow_audit_purge = 'true'` (istniejąca furtka) — o ile usuwamy dziennik, D-5 |
| `trigger_guard_tenant_ksef_claim_fields` (00117:309-367) | `tenants` | wyczyszczenie `ksef_verified_at` i środowiska **tylko** dla `postgres` (00117:338-347) | nagrobek musi je wyczyścić, inaczej unikalny indeks `(nip, ksef_verified_environment) WHERE ksef_verified_at IS NOT NULL` (00117:41-43) zablokuje ponowną rejestrację tej firmy w FaktWay |
| `ksef_send_attempts` — `REVOKE ALL … FROM service_role` (00150:85) | dziennik prób | tylko funkcje właściciela | funkcja `postgres` może usuwać |

**Nie wolno** obchodzić strażników przez `ALTER TABLE … DISABLE TRIGGER`
(blokuje tabelę i wyłącza strażników dla wszystkich firm naraz) ani przez
`SET session_replication_role = replica` (wyłącza też kaskady kluczy obcych →
osierocone wiersze). Stąd M3 zamiast „jednorazowego obejścia”.

### 6.3 Kolejność i klucze obce

| Krok | Tabele | Dlaczego tak |
|---|---|---|
| 1 | `expenses` | `expenses.ksef_invoice_id` wskazuje fakturę bez `ON DELETE` (00034:53; złożony klucz 00121:45-47) — usunięcie faktury najpierw by się odbiło |
| 2 | `invoices`, **od liści**: najpierw faktury, na które nic nie wskazuje | `parent_invoice_id … ON DELETE RESTRICT` (00012:60) i złożony klucz korekty (00118:9-12). Pętla „usuń faktury bez dzieci” aż do zera. Kaskadą znikają: pozycje, `ksef_submissions`, `ksef_send_attempts` (00150:38), `xml_documents`, `upo_receipts`, płatności i przypomnienia (00014:49, :143, 00073:70-78), `ksef_offline_queue` itd. Płatności **tylko** kaskadą: usunięte przed fakturą odpaliłyby przeliczenie `paid_amount` (00073:197-200), czyli UPDATE na zamrożonej fakturze. |
| 3 | pozostałe tabele z kluczem do `tenants` z listy „usuń” | po rundach: tabela, która odbije się od klucza innej tabeli, wraca do kolejnej rundy (§ 9 M4) |
| 4 | „wyzeruj”: `users.last_active_tenant_id` (00036:144-145), `support_conversations.tenant_id` (00054:41) | wiersze należą do użytkowników; rozmowy z pomocą mają własną retencję (#267) |
| 5 | nagrobek w `tenants` | po wszystkim, w tej samej transakcji |

**Klasyfikacja tabel jest fail-closed.** Funkcja na starcie czyta z katalogu
wszystkie klucze obce do `tenants` i odmawia, jeśli któraś tabela nie jest na
liście „usuń”, „wyzeruj” albo „zostaw”. Nowa tabela z `tenant_id` nie
przejdzie po cichu — ani nie zostanie (wyciek danych), ani nie zniknie
(utrata zapisów finansowych). Lista „zostaw” na dziś: `subscriptions`,
`stripe_payments`, `stripe_refunds`, `stripe_refund_operations`,
`stripe_financial_cases`, `billing_notifications`, `stripe_checkout_attempts`,
`stripe_customer_attempts`, `billing_invoice_counters` (00110:17, klucz
operatora), `tenant_closures`. Pełną listę „usuń” daje zapytanie
inwentaryzacyjne z § 9.0 na produkcji — w repo są tabele dodane poza
wzorcem `REFERENCES public.tenants`, więc migracje nie są tu pewnym źródłem.

### 6.4 Nagrobek

Wiersz `tenants` po usunięciu: `id`, `lifecycle_state = 'purged'`,
`purged_at`, `deleted_at`, `hard_delete_at`, `created_at`,
`stripe_customer_id` (złożony klucz `subscriptions (tenant_id,
stripe_customer_id)` z `ON UPDATE RESTRICT`, 00077:184-188, nie pozwala go
zmienić). Reszta kolumn: NULL albo wartość domyślna, dynamicznie z katalogu
(nowa kolumna nie przeżyje przez przeoczenie). `name` → „Firma usunięta”.
`nip` jest `NOT NULL` (00001:17) — D-7: zostawić czy zastąpić. Dane nabywcy
na naszych fakturach za abonament są w migawce faktury (`buyer_data`), więc
NIP na nagrobku nie jest do niczego potrzebny.

### 6.5 Pliki w magazynie S3 (MinIO / R2, Glacier)

| Klucze | Źródło |
|---|---|
| `${tenantId}/…` — XML, UPO, PDF faktur, import z KSeF, eksporty | `lib/storage/r2.ts:51-103`, `lib/pdf/pdf-storage.ts:51`, `lib/import/ksef-xml-archive.ts:34` |
| `tenants/${tenantId}/expenses/…` — zdjęcia kosztów (OCR) | `lib/storage/expenses.ts:82` |
| `exports/${tenantId}/…`, `imports/${tenantId}/…`, `upo/${tenantId}/…`, `reminders/${tenantId}/…` | `lib/storage/tenant-path.ts:13-16` (kanoniczna lista prefiksów), `exports-generate.ts:231`, `lib/import/file-storage.ts:15`, `lib/ksef/upo-storage.ts:8-12` |
| `archive_storage_path` w osobnym koszyku archiwum (Glacier) | `lib/storage/glacier.ts:23-53`, `archive-old-invoices` |

Usuwanie: (1) klucze jawne z wierszy bazy (`collectInvoiceStorageKeys`,
`lib/retention/invoice-files.ts:41`, w tym Glacier), (2) zamiatanie
wszystkich prefiksów z `tenant-path.ts` (lista + `DeleteObject`). Zawsze
**pliki przed wierszami** — wiersze są spisem plików; odwrotna kolejność
zostawiała pliki bez śladu (AUD-45, wzór w `retention-delete.ts:26-85`).
Po usunięciu wierszy drugie zamiatanie prefiksów jako kontrola (powinno
znaleźć 0). Glacier Deep Archive liczy minimum 180 dni przechowywania,
więc wcześniejsze usunięcie i tak jest płatne — D-8 (czy archiwum jest
w ogóle włączone na produkcji).

### 6.6 Kopie zapasowe

#264 (6f37fa78) dopasował umowę powierzenia § 9 ust. 2 do kodu: cykl
nadpisywania **≤ 60 dni** (dzienne do 30 dni, tygodniowe do 8 tygodni),
kopie ręczne usuwane w tym samym terminie, przy awarii ostatnie poprawne
kopie zostają do czasu nowych. Test `tests/unit/rodo-terminy-usuwania.test.ts`
(w #264) pilnuje, żeby stałe w kodzie i tekst się nie rozjechały.
Warstwy kopii według `docs/runbooks/backup-restore.md:12-17`:

| Warstwa | Retencja dziś | Zgodne z nową umową? |
|---|---|---|
| A. `pg_dump` na `db-1` (`scripts/hetzner/db-backup.sh`) | 14 ostatnich **kompletnych** (`db-backup.sh:41`, `:108-110`) | tak (przy codziennych zrzutach ≤ 30 dni; przy awarii starsze zostają — obejmuje to zdanie umowy o awarii) |
| B. Storage Box (kopia A poza serwerem) | `rclone copy`, nie `sync` — skasowanie na `db-1` nie kasuje kopii (`db-backup.sh:28-30`); retencja = snapshoty Storage Boxa; warstwa czeka na zakup | **nie wiadomo** — przy zakupie ustawić retencję ≤ 60 dni, inaczej kopie żyją bez końca |
| C. snapshot JSON `public.*` (`lib/backup/db-snapshot.ts:57-60`) | dzienne 30 dni (`cleanup-old-backups.ts:20`), tygodniowe 56 dni (`:21`), 7 ostatnich udanych bez względu na wiek (`:29`) | tak |
| C′. ręczne snapshoty (`kind = 'manual'`) | job ich **nie usuwa** (`cleanup-old-backups.ts:6`: „admin sam zarządza”) | **nie** — umowa mówi „usuwa w tym samym terminie”, a nie ma ani kodu, ani procedury |
| D. backup Hetznera (obraz dysku `db-1`) | 7 | tak, o ile dzienny — do sprawdzenia w konsoli |
| inne kopie na `db-1` (WAL/PITR, ręczne `pg_dump`, migawki) | nieznane | do sprawdzenia przez Bartosza |

Decyzja D-4. Najtańsze domknięcie C′: `cleanup-old-backups` usuwa także
`manual` starsze niż 60 dni — jedna gałąź w jobie, niezależnie od reszty
projektu.

### 6.7 Dziennik audytu i inne miejsca

| Miejsce | Propozycja |
|---|---|
| `audit_logs` firmy (numery faktur, nazwy kontrahentów w `metadata`) | D-5: usunąć w `purge_tenant_data` (furtka `app.allow_audit_purge`) — polecam; dowód usunięcia jest w `tenant_closures`, nie w `audit_logs` |
| zadania pg-boss z `tenantId` w danych (`pgboss.job`, archiwum) | znikają z retencją pg-boss; sprawdzić ustawienia w `lib/jobs/boss.ts:28` |
| procesorzy zewnętrzni (Resend, Sentry i inni z `lib/legal/subprocessors.ts` w #264) | według ich retencji; nic nie usuwamy ręcznie, ale lista wchodzi do potwierdzenia dla klienta |
| KSeF (MF) | nie dotyczy — faktury przechowuje KSeF niezależnie od nas (regulamin § 7) |

---

## 7. Ustalenie 4 — ścieżka operatora i potwierdzenie

### 7.1 Do czasu migracji: odcięcie ręczne (wykonuje Bartosz)

Bez migracji da się **odciąć dostęp**, ale **nie da się usunąć danych**
(§ 6.2, strażnik faktur). Dźwignia: każde wejście (RLS, `auth-context`,
`page-context`, `dashboard-shell-data`, `requireTenantMember`) wymaga
`memberships.status = 'active'`, a `'suspended'` jest dozwolone (00036:22-23)
i nieużywane w kodzie. Wszystko odwracalne. Kolejność dla firmy `X`
w dniu T0+30 (albo od razu przy poleceniu wcześniejszego usunięcia):

```sql
-- 0. tylko odczyt: czy nic nie jest w drodze do KSeF (ma być 0)
SELECT count(*) FROM public.invoices
 WHERE tenant_id = 'X' AND ksef_status IN ('queued', 'offline_queued', 'sending');

BEGIN;
-- 1. odcięcie członków (RLS, aplikacja, joby z requireTenantMember)
UPDATE public.memberships SET status = 'suspended'
 WHERE organization_id = 'X' AND status = 'active';
-- 2. linki księgowej
UPDATE public.accountant_access SET revoked_at = now()
 WHERE tenant_id = 'X' AND revoked_at IS NULL;
-- 3. maile do kontrahentów i księgowej
UPDATE public.reminder_settings SET enabled = false WHERE tenant_id = 'X';
UPDATE public.accountant_settings SET co_pilot_enabled = false WHERE tenant_id = 'X';
-- 4. KSeF: inbox-polling wybiera firmy z danymi uwierzytelniającymi
--    (inbox-polling.ts:136-145); certyfikat klient i tak powinien cofnąć w KSeF
UPDATE public.tenants
   SET ksef_credentials_encrypted = NULL, ksef_certificate_expiry = NULL,
       is_active = false, deleted_at = COALESCE(deleted_at, now())
 WHERE id = 'X';
-- 5. ślad: wpis w audit_logs (INSERT jest dozwolony)
INSERT INTO public.audit_logs (tenant_id, action, metadata)
VALUES ('X', 'tenant.closure.manual_lock',
        jsonb_build_object('t0', '<data>', 'export_until', '<data>',
                           'purge_deadline', '<data>', 'requested_by', '<e-mail>'));
COMMIT;
```

Przed tym operator (według `docs/support/escalation-matrix.md` z #271):
potwierdza, że pisze właściciel; proponuje eksport; anuluje subskrypcję
w panelu Stripe na koniec okresu; zapisuje T0, `export_until` i T0+60.
**Termin T0+60 to twardy termin na wdrożenie M1–M4** — po nim nie
dotrzymujemy umowy powierzenia.

### 7.2 Docelowo: akcje w `/admin` i RPC

| Akcja w `/admin` → firma | RPC (M5) | Przejście | Potwierdzenie |
|---|---|---|---|
| „Rozwiąż umowę” — powód, data T0, kanał, e-mail zlecającego, notatka „jak sprawdziłem nadawcę” | `open_tenant_closure(...)` | `active → closing` (albo zaplanowane, gdy T0 w przyszłości — nasze wypowiedzenie z 30-dniowym okresem) | wpisanie NIP firmy |
| „Cofnij zamknięcie” | `cancel_tenant_closure(...)` | `closing → active`, tylko przed `export_until` | wpisanie NIP |
| „Usuń teraz (polecenie klienta)” | `lock_tenant_now(...)` | `closing → locked`, `hard_delete_at = now() + 30 dni` | wpisanie NIP + „USUŃ” |
| „Eksport dla klienta” (umowa § 9 ust. 1: przekazujemy dane na żądanie) | — (istniejący `exports-generate` uruchomiony przez operatora) | — | — |

Każde RPC: `SECURITY DEFINER`, tylko `service_role`, wpis w `audit_logs`
i w `tenant_closures`. Akcja serwera sprawdza `requireAdmin()` jak
`app/admin/users/actions.ts`. Przejścia po terminie robi cron (§ 8).

### 7.3 Maile

| Mail | Kiedy | Do kogo | Treść |
|---|---|---|---|
| Planowane usunięcie (regulamin § 14 ust. 6) | przy `closing` | właściciele; członkowie — informacyjnie | data T0, do kiedy eksport (`export_until`), jak wyeksportować, data najpóźniejszego usunięcia, że faktury są w KSeF, że obowiązek przechowywania jest po stronie klienta, jak cofnąć uprawnienia FaktWay w KSeF |
| Przypomnienie | 7 dni przed `export_until` | właściciele | jw. skrótem |
| Potwierdzenie usunięcia (umowa § 9 ust. 2) | po `purged` | zlecający (`requester_email`) i właściciele | data usunięcia, co usunięto (liczby z `tenant_closures`), co zostało i dlaczego (nasze dokumenty rozliczeń, nagrobek), kiedy znikną kopie zapasowe (najpóźniej `purged_at` + 60 dni), że faktury są w KSeF |

Umowa mówi „na żądanie potwierdza” — polecam wysyłać zawsze: jest tanio,
a klient nie musi pamiętać, żeby prosić.

Po wdrożeniu da się przywrócić samoobsługę w `/settings` (zamiast „napisz
do pomocy” z #271): przycisk zakłada zamknięcie przez to samo RPC
z potwierdzeniem NIP. Wtedy obietnica ma pokrycie.

---

## 8. Ustalenie 5 — job usuwający: idempotencja i ponowienie od zera

Nowy cron `cron.tenant-lifecycle` raz dziennie (liczba cronów 27 → 28:
zmienić świadomie stałe w testach i w kontroli „27/27 cronów”). Worker
pg-boss wykonuje cały handler od nowa, bez pamięci kroków, więc każdy krok
sam sprawdza, czy jest już zrobiony.

| Krok | Mechanizm | Ponowienie po tym kroku |
|---|---|---|
| 1. przejścia po terminie | RPC `advance_tenant_lifecycle(now())`: zaplanowane `active → closing` (T0 minęło), `closing → locked` (`export_until` minął, nic w drodze do KSeF — § 4.5) | warunki w `UPDATE … WHERE lifecycle_state = …` — drugi przebieg nic nie zmienia |
| 2. Stripe przy `closing` | `cancel_at_period_end` z kluczem idempotencji Stripe `closure-<id>-cancel`; potem `stripe_cancel_requested_at` | ustawienie jest idempotentne po stronie Stripe; brak znacznika → próba jeszcze raz |
| 3. maile „planowane usunięcie” i przypomnienie | zajęcie: `UPDATE … SET notice_claimed_at = now() WHERE notice_claimed_at IS NULL RETURNING`; Resend z `idempotencyKey = tenant-closure-notice/<id>`; potem `notice_sent_at` | zajęte, niewysłane po 24 h → alarm, **bez** automatycznej powtórki (wzór `billing_notifications`, 00077:190-195) |
| 4. pliki (`locked`) | klucze jawne + zamiatanie prefiksów; brak obiektu = sukces; potem `files_purged_at`, `files_deleted` | idempotentne; przerwane w połowie → kolejny przebieg dokończy |
| 5. baza | `purge_tenant_data(tenant, closure)`: jedna transakcja; drugi raz zwraca `already_purged` | błąd = rollback całości, nic połowicznego |
| 6. kontrola plików | zamiatanie prefiksów jeszcze raz; > 0 → alarm | idempotentne |
| 7. potwierdzenie | jak krok 3, klucz `tenant-closure-confirmation/<id>`, potem `confirmation_sent_at` | jw. |

Pojedyncze wywołanie obsługuje jedną firmę na raz (`singletonKey =
closure.id`), a cron nie usuwa niczego bez wpisu w `tenant_closures`.

Alarmy (`critical-alerts-monitor`): firma w `locked` bez `purged_at`
7 dni przed `hard_delete_at`; `closing` po `export_until` z fakturami
w drodze; zajęty, niewysłany mail; niezerowe zamiatanie kontrolne.

---

## 9. Szkic SQL

Numery migracji z rejestru (`docs/koordynacja/CLAUDE-DO-CODEXA.md`,
„następny wolny” — dziś na `main` 00151, sprawdź rezerwacje innych PR).
Wszystkie M1–M5 **przed wdrożeniem kodu**: są addytywne, a po M2 żadna
firma się nie zamyka, dopóki operator jej nie zamknie.

### 9.0 Zapytania tylko do odczytu (przed pisaniem migracji)

```sql
-- a) firmy oflagowane starą akcją (§ 2.3, decyzja D-9)
SELECT id, name, nip, deleted_at, hard_delete_at, is_active, created_at
  FROM public.tenants
 WHERE deleted_at IS NOT NULL OR hard_delete_at IS NOT NULL OR is_active = false
 ORDER BY deleted_at NULLS LAST;

-- b) wszystkie klucze obce do tenants z akcją ON DELETE (lista „usuń / wyzeruj / zostaw”)
SELECT c.conrelid::regclass AS tabela,
       pg_get_constraintdef(c.oid) AS definicja,
       c.confdeltype AS przy_usunieciu  -- a=no action r=restrict c=cascade n=set null
  FROM pg_constraint c
 WHERE c.contype = 'f' AND c.confrelid = 'public.tenants'::regclass
 ORDER BY 1;

-- c) kolumny z identyfikatorem firmy BEZ klucza obcego (nie złapie ich lista z b)
SELECT table_schema, table_name, column_name
  FROM information_schema.columns col
 WHERE table_schema IN ('public')
   AND column_name IN ('tenant_id', 'organization_id', 'operator_tenant_id')
   AND NOT EXISTS (
     SELECT 1 FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.contype = 'f' AND c.confrelid = 'public.tenants'::regclass
       AND c.conrelid = format('%I.%I', col.table_schema, col.table_name)::regclass
       AND a.attname = col.column_name);

-- d) właściciel funkcji strażników (furtka M3 zakłada postgres)
SELECT p.proname, p.proowner::regrole
  FROM pg_proc p
 WHERE p.proname IN ('guard_invoice_pending_content', 'prevent_audit_logs_mutate',
                     'guard_tenant_ksef_claim_fields', 'is_member_of');
```

### 9.1 M1 — stan firmy, rejestr zamknięć, strażnik kolumn

```sql
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'active'
    CONSTRAINT tenants_lifecycle_state_check
    CHECK (lifecycle_state IN ('active', 'closing', 'locked', 'purged')),
  ADD COLUMN IF NOT EXISTS export_until timestamptz,
  ADD COLUMN IF NOT EXISTS purged_at timestamptz;

CREATE TABLE public.tenant_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (reason IN (
    'client_termination',        -- § 14 ust. 2
    'client_early_deletion',     -- umowa powierzenia § 9 ust. 3
    'provider_notice',           -- § 14 ust. 3 (30 dni)
    'provider_immediate')),      -- § 14 ust. 4
  request_channel text NOT NULL CHECK (request_channel IN ('email', 'admin', 'self_service')),
  requested_at timestamptz NOT NULL,          -- data oświadczenia (mail)
  requester_email text,                       -- kto zlecił (dowód)
  verification_note text NOT NULL,            -- jak operator potwierdził nadawcę
  opened_by uuid NOT NULL,                    -- operator; bez FK, konto może zniknąć
  effective_at timestamptz NOT NULL,          -- T0
  export_until timestamptz NOT NULL,          -- T0 + 30 dni albo T0
  purge_deadline timestamptz NOT NULL,        -- = tenants.hard_delete_at
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_note text,
  stripe_cancel_requested_at timestamptz,
  notice_claimed_at timestamptz,
  notice_sent_at timestamptz,
  locked_at timestamptz,
  files_purged_at timestamptz,
  files_deleted integer,
  purged_at timestamptz,
  rows_deleted jsonb,
  confirmation_claimed_at timestamptz,
  confirmation_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (export_until >= effective_at),
  CHECK (purge_deadline <= export_until + interval '30 days'),
  CHECK (cancelled_at IS NULL OR purged_at IS NULL)
);
-- jedno otwarte zamknięcie na firmę
CREATE UNIQUE INDEX uq_tenant_closures_open
  ON public.tenant_closures (tenant_id) WHERE cancelled_at IS NULL;
ALTER TABLE public.tenant_closures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenant_closures FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tenant_closures TO service_role;  -- zapis tylko przez RPC (M5)

-- Klient nie zmienia stanu firmy. Odebranie uprawnienia do kolumny nie działa
-- przy uprawnieniu do tabeli (00079:63-65), więc wyzwalacz.
CREATE OR REPLACE FUNCTION public.guard_tenant_lifecycle_fields()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND ROW(
       NEW.lifecycle_state, NEW.export_until, NEW.purged_at,
       NEW.deleted_at, NEW.hard_delete_at, NEW.is_active
     ) IS DISTINCT FROM ROW(
       OLD.lifecycle_state, OLD.export_until, OLD.purged_at,
       OLD.deleted_at, OLD.hard_delete_at, OLD.is_active) THEN
    RAISE EXCEPTION 'Stan firmy zmienia tylko operator' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_tenant_lifecycle_fields() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER a_guard_tenant_lifecycle_fields
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_lifecycle_fields();
```

Uwaga: strażnik zamyka też `deleted_at`/`is_active` dla klienta. Na `main`
pisze je klientem `requestAccountDeletionAction` — #271 musi wejść przed M1.

### 9.2 M2 — helpery RLS

```sql
CREATE OR REPLACE FUNCTION public.is_member_of(p_org uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.memberships m
      JOIN public.tenants t ON t.id = m.organization_id
     WHERE m.organization_id = p_org
       AND m.user_id = auth.uid()
       AND m.status = 'active'
       AND t.lifecycle_state IN ('active', 'closing'));
$$;

CREATE OR REPLACE FUNCTION public.has_org_role(p_org uuid, p_role text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.memberships m
      JOIN public.tenants t ON t.id = m.organization_id
     WHERE m.organization_id = p_org
       AND m.user_id = auth.uid()
       AND m.status = 'active'
       AND m.role = p_role
       AND t.lifecycle_state IN ('active', 'closing'));
$$;

CREATE OR REPLACE FUNCTION public.shares_active_org_with(p_user uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.memberships me
      JOIN public.memberships peer
        ON peer.organization_id = me.organization_id AND peer.status = 'active'
      JOIN public.tenants t ON t.id = me.organization_id
     WHERE me.user_id = auth.uid()
       AND me.status = 'active'
       AND peer.user_id = p_user
       AND t.lifecycle_state IN ('active', 'closing'));
$$;
-- get_current_tenant_id() bez zmian: woła is_member_of (00037:102).
-- Uprawnienia EXECUTE zostają z 00037/00058 (CREATE OR REPLACE ich nie zmienia).
```

Wariant D-2b (tylko odczyt w `closing` na poziomie bazy) wymagałby osobnej
funkcji dla zapisu i podmiany w każdej polityce INSERT/UPDATE/DELETE —
dziesiątki polityk. Polecam D-2a (w aplikacji) i blokadę tylko w jednym
miejscu bazy, które ma efekt zewnętrzny: wejściu do wysyłki KSeF
(`enqueue_ksef_send`, 00131:144) — nowa wysyłka z `closing` odmawia, kolejka
offline i ponowienia już zakolejkowanych działają.

### 9.3 M3 — furtka w strażniku faktur

Pełna treść funkcji z 00132:37-135 (`CREATE OR REPLACE`), zmieniona tylko
gałąź DELETE:

```sql
  IF TG_OP = 'DELETE' THEN
    -- Usunięcie danych zamkniętej firmy (purge_tenant_data, właściciel postgres).
    -- Flaga ma wartość tenant_id, więc nie otwiera faktur innej firmy w tej
    -- samej transakcji, a service_role nie przejdzie, nawet gdy ustawi flagę.
    IF current_user = 'postgres'
       AND pg_catalog.current_setting('app.tenant_purge', true) = OLD.tenant_id::text THEN
      RETURN OLD;
    END IF;
    v_locked := OLD.ksef_status IN ('queued', 'offline_queued', 'sending')
      OR OLD.offline_idempotency_key IS NOT NULL
      OR OLD.submitted_to_ksef_at IS NOT NULL
      OR (current_user IN ('authenticated', 'anon') AND OLD.ksef_status = 'accepted');
    IF v_locked THEN
      RAISE EXCEPTION 'KSeF document cannot be deleted by this role'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
```

### 9.4 M4 — `purge_tenant_data`

```sql
CREATE OR REPLACE FUNCTION public.purge_tenant_data(p_tenant_id uuid, p_closure_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER                      -- właściciel: postgres (§ 6.2)
SET search_path = ''
AS $$
DECLARE
  -- Lista z migracji w repo (stan 1ded2147). Przed wgraniem porównać
  -- z zapytaniem 9.0 b na produkcji. Kolejność ma znaczenie tylko dla
  -- czytelności: rundy niżej i tak ją poprawią. Tabele zależne od faktur
  -- są puste po kroku 4 (kaskada), ale muszą być na liście, bo mają też
  -- własny klucz do tenants.
  v_delete text[] := ARRAY[
    -- zależne od faktur (00001, 00014, 00015, 00150)
    'public.ksef_submissions', 'public.xml_documents', 'public.upo_receipts',
    'public.ksef_offline_queue', 'public.ksef_send_attempts',
    'public.payments', 'public.payment_imports', 'public.payment_reminders',
    -- dane firmy
    'public.kpir_entries', 'public.contractors', 'public.products',
    'public.ksef_sessions', 'public.ksef_inbox_cursor', 'public.import_jobs',
    'public.ocr_jobs', 'public.categorization_rules',
    'public.reminder_settings', 'public.reminder_templates',
    'public.accountant_access', 'public.accountant_settings',
    'public.export_jobs', 'public.export_files',
    'public.push_subscriptions', 'public.tenant_feature_flags',
    'public.flo_proposals', 'public.flo_approvals', 'public.flo_decisions',
    'public.flo_prefs', 'public.flo_usage', 'public.flo_shadow', 'public.flo_kind_flags',
    'public.memberships', 'public.organization_invitations',
    'public.organization_join_requests',
    'public.inngest_run_log', 'public.audit_logs' ];   -- audit_logs: D-5
  v_nullify text[] := ARRAY['public.users', 'public.support_conversations'];
  v_keep text[] := ARRAY[
    'public.subscriptions', 'public.stripe_payments', 'public.stripe_refunds',
    'public.stripe_refund_operations', 'public.stripe_financial_cases',
    'public.billing_notifications', 'public.stripe_checkout_attempts',
    'public.stripe_customer_attempts', 'public.billing_invoice_counters',
    'public.tenant_closures',
    'public.expenses', 'public.invoices'];   -- te dwie osobno, kroki 2–3
  v_state text;
  v_unknown text[];
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
  v_total bigint;
  v_todo text[];
  v_pending text[];
  v_tbl text;
  v_col text;
  v_round int;
BEGIN
  -- 1. Wejście: firma zablokowana, pliki usunięte, nic w drodze do KSeF
  SELECT t.lifecycle_state INTO v_state
    FROM public.tenants t WHERE t.id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nie ma firmy %', p_tenant_id USING ERRCODE = 'P0002';
  END IF;
  IF v_state = 'purged' THEN
    RETURN jsonb_build_object('already_purged', true);
  END IF;
  IF v_state <> 'locked' THEN
    RAISE EXCEPTION 'Firma % jest w stanie %, nie locked', p_tenant_id, v_state
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM public.tenant_closures c
   WHERE c.id = p_closure_id AND c.tenant_id = p_tenant_id
     AND c.cancelled_at IS NULL AND c.files_purged_at IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Brak otwartego zamknięcia z usuniętymi plikami' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices i WHERE i.tenant_id = p_tenant_id
              AND i.ksef_status IN ('queued', 'offline_queued', 'sending')) THEN
    RAISE EXCEPTION 'Firma ma faktury w drodze do KSeF' USING ERRCODE = '55000';
  END IF;

  -- 2. Fail-closed: każda tabela z kluczem do tenants ma decyzję
  SELECT pg_catalog.array_agg(DISTINCT c.conrelid::pg_catalog.regclass::text)
    INTO v_unknown
    FROM pg_catalog.pg_constraint c
   WHERE c.contype = 'f'
     AND c.confrelid = 'public.tenants'::pg_catalog.regclass
     AND NOT (c.conrelid::pg_catalog.regclass::text = ANY (v_delete || v_nullify || v_keep));
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'Tabele bez decyzji przy usuwaniu firmy: %', v_unknown
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.set_config('app.tenant_purge', p_tenant_id::text, true);
  PERFORM pg_catalog.set_config('app.allow_audit_purge', 'true', true);  -- D-5

  -- 3. Koszty przed fakturami (expenses.ksef_invoice_id bez ON DELETE)
  DELETE FROM public.expenses WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('public.expenses', v_n);

  -- 4. Faktury od liści (parent_invoice_id ON DELETE RESTRICT); pozycje,
  --    wysyłki, UPO, płatności, przypomnienia — kaskadą
  v_total := 0;
  LOOP
    DELETE FROM public.invoices i
     WHERE i.tenant_id = p_tenant_id
       AND NOT EXISTS (SELECT 1 FROM public.invoices ch WHERE ch.parent_invoice_id = i.id);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    EXIT WHEN v_n = 0;
    v_total := v_total + v_n;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE tenant_id = p_tenant_id) THEN
    RAISE EXCEPTION 'Zostały faktury (cykl parent_invoice_id?)' USING ERRCODE = '55000';
  END IF;
  v_counts := v_counts || jsonb_build_object('public.invoices', v_total);

  -- 5. Reszta: rundami, bo tabele mogą wskazywać na siebie nawzajem
  v_todo := v_delete;
  FOR v_round IN 1..5 LOOP
    v_pending := '{}';
    FOREACH v_tbl IN ARRAY v_todo LOOP
      FOR v_col IN
        SELECT a.attname
          FROM pg_catalog.pg_constraint c
          JOIN pg_catalog.pg_attribute a
            ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.contype = 'f'
           AND c.conrelid = v_tbl::pg_catalog.regclass
           AND c.confrelid = 'public.tenants'::pg_catalog.regclass
           AND pg_catalog.array_length(c.conkey, 1) = 1
      LOOP
        BEGIN
          EXECUTE pg_catalog.format('DELETE FROM %s WHERE %I = $1', v_tbl, v_col)
            USING p_tenant_id;
          GET DIAGNOSTICS v_n = ROW_COUNT;
          v_counts := v_counts || jsonb_build_object(v_tbl,
            COALESCE((v_counts ->> v_tbl)::bigint, 0) + v_n);
        EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN
          v_pending := v_pending || v_tbl;
        END;
      END LOOP;
    END LOOP;
    EXIT WHEN pg_catalog.cardinality(v_pending) = 0;
    v_todo := v_pending;
  END LOOP;
  IF pg_catalog.cardinality(v_pending) > 0 THEN
    RAISE EXCEPTION 'Nie usunięto: %', v_pending USING ERRCODE = '55000';
  END IF;

  -- 6. Wyzeruj powiązania należące do użytkowników
  UPDATE public.users SET last_active_tenant_id = NULL
   WHERE last_active_tenant_id = p_tenant_id;
  UPDATE public.support_conversations SET tenant_id = NULL
   WHERE tenant_id = p_tenant_id;

  -- 7. Nagrobek: kolumny poza listą zostaw → NULL albo DEFAULT (dynamicznie,
  --    żeby nowa kolumna nie przeżyła przez przeoczenie). Szkic:
  --    FOR kolumna IN information_schema.columns(tenants) − keep LOOP
  --      nullable → NULL; NOT NULL z DEFAULT → DEFAULT; inaczej RAISE.
  --    keep = id, created_at, stripe_customer_id, lifecycle_state, export_until,
  --           purged_at, deleted_at, hard_delete_at, is_active, nip (D-7)
  UPDATE public.tenants t
     SET name = 'Firma usunięta',
         ksef_credentials_encrypted = NULL,   -- wymaga postgres (00117:309-367)
         ksef_certificate_expiry = NULL,
         ksef_verified_at = NULL,             -- zwalnia indeks NIP (00117:41-43)
         ksef_verified_environment = NULL,
         ksef_authority_user_id = NULL,
         lifecycle_state = 'purged',
         purged_at = pg_catalog.now(),
         is_active = false
   WHERE t.id = p_tenant_id;

  UPDATE public.tenant_closures
     SET purged_at = pg_catalog.now(), rows_deleted = v_counts
   WHERE id = p_closure_id;

  RETURN v_counts;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_tenant_data(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_tenant_data(uuid, uuid) TO service_role;
```

Uwagi do szkicu:

- Złożone klucze (np. `subscriptions (tenant_id, stripe_customer_id)`)
  są na liście „zostaw”; pętla obsługuje tylko klucze jednokolumnowe
  i to sprawdza (`array_length = 1`). Złożony klucz na liście „usuń”
  trzeba dopisać ręcznie.
- `restrict_violation` i `foreign_key_violation` w rundach łapią tylko
  zależności między tabelami „usuń”. Inny błąd przerywa całość (rollback).
- Pozycje faktur znikają wyłącznie kaskadą (§ 6.2, `b_guard_pending_invoice_lines`).

### 9.5 M5 — przejścia stanów (RPC dla `/admin` i crona)

Szkic sygnatur; treść według § 7.2 i § 8:

```sql
-- operator: active → closing (albo zaplanowane, gdy p_effective_at > now())
CREATE FUNCTION public.open_tenant_closure(
  p_tenant_id uuid, p_reason text, p_channel text, p_requested_at timestamptz,
  p_requester_email text, p_verification_note text, p_operator uuid,
  p_effective_at timestamptz, p_early_deletion boolean) RETURNS uuid ...;
  --  ustawia tenants: lifecycle_state, deleted_at = effective_at, export_until,
  --  hard_delete_at, is_active = false; odwołuje zaproszenia i prośby;
  --  wyłącza Co-Pilota i przypomnienia; zapis w audit_logs.

-- operator: closing → active, tylko przed export_until i bez purge
CREATE FUNCTION public.cancel_tenant_closure(
  p_closure_id uuid, p_operator uuid, p_note text) RETURNS void ...;

-- operator albo cron: closing → locked (odmowa przy fakturach w drodze, § 4.5);
-- odwołuje linki księgowej, czyści dane uwierzytelniające KSeF
CREATE FUNCTION public.lock_tenant(p_closure_id uuid, p_now timestamptz) RETURNS void ...;

-- cron: zaplanowane active → closing oraz closing → locked po terminie;
-- zwraca zamknięcia do obsługi (Stripe, maile, purge)
CREATE FUNCTION public.advance_tenant_lifecycle(p_now timestamptz)
  RETURNS TABLE (closure_id uuid, tenant_id uuid, lifecycle_state text) ...;

-- wszystkie: SECURITY DEFINER, SET search_path = '', REVOKE od PUBLIC/anon/
-- authenticated, GRANT EXECUTE tylko service_role, warunek stanu w UPDATE
```

---

## 10. Testy, które muszą powstać

Na bazie (`tests/rls-*.test.ts`, job CI „RLS isolation”), nie w pamięci —
helpery, wyzwalacze i kaskady nie istnieją w mockach:

| # | Test | Czerwony przed zmianą? |
|---|---|---|
| T1 | członek firmy `closing` widzi faktury; członek firmy `locked` — 0 wierszy, `get_current_tenant_id()` = NULL; ta sama osoba w drugiej firmie `active` widzi ją dalej | tak (dziś stan firmy nie istnieje) |
| T2 | `authenticated` (właściciel) nie zmieni `lifecycle_state`, `deleted_at`, `is_active` | tak (dziś `tenants_update_own_owner` pozwala) |
| T3 | `purge_tenant_data` na firmie z: fakturą zaakceptowaną w KSeF, łańcuchem korekt, kosztem z KSeF powiązanym z fakturą, szkicem wycofanym (00148), wpisami audytu, płatnością Stripe ze sprawą finansową i przeglądem → przechodzi; tabele „zostaw” nietknięte; **druga firma bez zmian** (liczniki przed i po) | tak (dziś `DELETE FROM tenants` pada na (a)–(c) z § 6.1) |
| T4 | drugie wywołanie zwraca `already_purged` | — |
| T5 | `service_role` z ustawioną `app.tenant_purge` dalej nie usunie wysłanej faktury | — (strażnik regresji) |
| T6 | nowa tabela testowa z kluczem do `tenants` bez decyzji → funkcja odmawia | — |
| T7 | po nagrobku nowa firma z tym samym NIP przechodzi weryfikację KSeF (indeks 00117:41-43) | — |
| T8 | `lock_tenant` odmawia przy fakturze `sending`, przechodzi po jej zakończeniu | — |

W Vitest: strażnik „każdy cron sklasyfikowany” (§ 4.4), `assertTenantOperational`
w jobach zdarzeniowych, trzy wejścia portalu księgowej, `auth-context`
i `page-context` z firmą `locked`.

---

## 11. Kolejność prac (każdy punkt = osobny PR od `main`)

| # | Co | Zależy od |
|---|---|---|
| 0 | panel admina bez flag firm przy usuwaniu konta (§ 2.2) | #267, #270 |
| 1 | M1–M4 + T1–T7 | #271 (strażnik kolumn z M1) |
| 2 | aplikacja: `lib/tenants/lifecycle.ts`, `auth-context`, `page-context`, przełącznik, baner, portal księgowej | 1 |
| 3 | joby: `assertTenantOperational`, filtry z § 4.4, strażnik „każdy cron sklasyfikowany” | 1 |
| 4 | M5 + akcje w `/admin` + Stripe + maile + `cron.tenant-lifecycle` (28 cronów) + alarmy + T8 | 1–3 |
| 5 | kopie ręczne w `cleanup-old-backups` + retencja Storage Boxa (D-4) | — (może iść od razu) |
| 6 | samoobsługa w `/settings` (zamiast „napisz do pomocy”) | 4 |

Punkty 1–4 muszą zdążyć w 60 dni od pierwszego zlecenia (§ 0).
Punkt 5 jest niezależny i najtańszy: kopie ręczne to dziś niezgodność z umową w wersji z #264.

---

## 12. Poprawki względem #272

| #272 | Stan faktyczny |
|---|---|
| § 4.7: `audit_logs.tenant_id … ON DELETE SET NULL` (00001) + strażnik UPDATE | 00008:17-21 zmieniło klucz na `ON DELETE CASCADE`. Kaskada to DELETE i odbija się od `trg_audit_logs_prevent_delete` (00052:37-41). Wniosek „DELETE się wywróci” zostaje, mechanizm i skutek inne: wpisy byłyby usunięte, nie wyzerowane. |
| § 4.7: lista strażników przy usuwaniu | brakowało `b_guard_invoice_pending_content` (00132:63-72), który blokuje **każdą** rolę, oraz RESTRICT spraw finansowych Stripe (00080:47-49) i strażnika NIP (00117:309-367). Strażnicy 00148 i 00128, o które #272 pytał, przepuszczają role spoza API. |
| § 4.4: klucze billingu → `SET NULL` | zamiast tego nagrobek (§ 6.1): bez zmian w tabelach z ciężkimi strażnikami. |
| § 4.5: dane uwierzytelniające KSeF kasować przy `closing` | dopiero przy `locked`: w `closing` kolejka Offline24 musi dosłać faktury (§ 4.4), a do tego potrzebne są dane uwierzytelniające. |

---

## 13. Decyzje dla Bartosza

| # | Decyzja | Polecam |
|---|---|---|
| D-1 | Gdzie trzymać stan: nowa kolumna + `tenant_closures` czy stare flagi | nowa kolumna + rejestr (§ 3.2) |
| D-2 | `closing`: (a) pełny dostęp jak w regulaminie („pozostaje dostępna”) + blokada tylko nowej wysyłki KSeF, (b) tylko odczyt w aplikacji, (c) tylko odczyt w RLS | (a) albo (b); (c) za drogie (§ 9.2) |
| D-3 | Portal księgowej w `closing`: zostaje czy od razu odwołany | zostaje, odwołanie przy `locked` |
| D-4 | Kopie zapasowe (umowa w #264: cykl ≤ 60 dni, ręczne w tym samym terminie): kto usuwa kopie `manual` — job czy operator; retencja Storage Boxa przy zakupie; czy na `db-1` są kopie poza opisanymi warstwami (WAL/PITR, ręczne `pg_dump`, migawki) | job usuwa `manual` po 60 dniach; Storage Box ≤ 60 dni; sprawdzić `db-1` i warstwę D w konsoli Hetznera |
| D-5 | Dziennik audytu firmy: usunąć przy purge czy zostawić do 12-miesięcznego czyszczenia | usunąć; dowód w `tenant_closures` |
| D-6 | Jak długo trzymamy `tenant_closures` i nasze zapisy Stripe po `purged` | zapisy Stripe — okres przedawnienia zobowiązania podatkowego; `tenant_closures` — tyle samo (dowód wykonania umowy). Do potwierdzenia z księgową/prawnikiem. |
| D-7 | NIP na nagrobku: zostawić czy zastąpić | zastąpić (nie jest potrzebny, § 6.4); wymaga znacznika zamiast NIP i zgody strażnika NIP (funkcja `postgres` przechodzi) |
| D-8 | Archiwum Glacier: czy włączone na produkcji (zmienne `AWS_ARCHIVE_BUCKET`/`AWS_GLACIER_BUCKET`) | sprawdzić; jeśli nie — wyrzucić z zakresu |
| D-9 | Firmy oflagowane starą akcją (§ 2.3, zapytanie 9.0 a): napisać do właścicieli i zamknąć według nowej procedury czy zdjąć flagi | napisać; bez odpowiedzi — zdjąć flagi (firma działała, ludzie mogą z niej korzystać) |
| D-10 | Mail do wszystkich członków przy `closing` czy tylko do właściciela | do wszystkich (§ 4.3) |
| D-11 | Wcześniejsze usunięcie na polecenie klienta: od razu `locked` czy krótka karencja (np. 3 dni na pomyłkę) | 3 dni karencji w `closing`, potem `locked` |
