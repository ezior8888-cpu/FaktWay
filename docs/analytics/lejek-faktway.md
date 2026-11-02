# Lejek FaktWay: zdarzenia, zgoda, źródło wejścia

Pomiar z `FAKTWAY-1-0` (sekcja 3 pkt 7): rejestracja, podłączenie KSeF, pierwsza
faktura, próba, płatność, odejście, źródło. Pierwsze trzy miesiące tych liczb mają
odpowiedzieć, w którym wariancie ruchu jesteście.

Kod: `lib/analytics/server.ts` (bramka zgody), `lib/analytics/funnel.ts` (zdarzenia),
`lib/analytics/attribution.ts` (źródło), `lib/analytics/privacy.ts` (lista dozwolonych
pól), migracja `00161`. Pełny słownik wszystkich zdarzeń: [event-dictionary.md](event-dictionary.md).

## Dwa źródła liczb

| | PostHog | Karta „Lejek firm” w `/admin` |
|---|---|---|
| Skąd | zdarzenia wysłane za zgodą | SQL na naszej bazie (`admin_funnel_weekly`) |
| Kto się liczy | tylko osoby ze zgodą | wszystkie firmy, źródła tylko ze zgodą właściciela |
| Dane osobowe | pseudonimowy identyfikator osoby i firmy | żadnych, same liczby |
| Do czego | ścieżki, czas między krokami, podział na kampanie | prawdziwa skala lejka |

**Liczby z PostHoga będą niższe niż z `/admin` i tak ma być.** Do decyzji o skali
bierz `/admin`, a PostHoga do pytania „gdzie i dlaczego odpadają”.

## Zgoda

- `users.analytics_consent` (`granted`, `denied`, `NULL`) i `analytics_consent_at`.
- Wybór w banerze działa w przeglądarce od razu, a na serwer idzie akcją
  `syncAnalyticsConsentAction`. Po zalogowaniu `AnalyticsIdentify` synchronizuje
  w obie strony: **ostatni wybór wygrywa**, porównuje atomowo RPC `sync_analytics_consent`.
- Wyjątek od „ostatni wygrywa”: wybór raz dostarczony na konto nie jest już nowy.
  Przy wspólnym komputerze druga osoba nie dostaje cudzego „tak”; jeśli sama nie ma
  decyzji, baner pyta ją od nowa.
- Drugi wyjątek: odwołanie wygrywa zawsze. RPC stempluje je czasem serwera, więc zegar
  urządzenia (np. 2 h do tyłu) go nie blokuje, a powtórzone odwołanie niczego nie zmienia.
  Cena: starsze odwołanie, które dotarło późno, przebija nowszą zgodę z innego urządzenia.
- Zgoda w localStorage bez daty pochodzi sprzed 11.2026, gdy baner mówił o samych statystykach.
  Liczy się jak brak decyzji: baner pyta od nowa, nic nie trafia na konto ani do ciasteczka.
  Odmowa bez daty zostaje.
- Każde zdarzenie z serwera przechodzi przez `trackServer`, a ten przy każdym zdarzeniu
  czyta bazę. Brak `granted`, błąd odczytu albo brak właściciela = brak zdarzenia.
- Zdarzenia firmy (webhook Stripe, wysyłka do KSeF) nie mają przeglądarki, więc liczy
  się zgoda **najstarszego aktywnego właściciela** (`analytics_tenant_owner`). Na niego
  też idzie `distinct_id`, dzięki czemu lejek widzi jedną osobę od rejestracji po płatność.
- Odwołanie: przeglądarka przestaje wysyłać od razu, ciasteczko źródła znika od razu,
  serwer przestaje wysyłać przy następnym zdarzeniu, `users.signup_source` jest kasowane.
- Miejsca zmiany: baner, `/legal/cookies`, Ustawienia → Konto i dane (RODO).
- Każda zmiana decyzji to wpis `analytics.consent_changed` w `audit_logs` z wersją
  oświadczenia (`ANALYTICS_STATEMENT` w `lib/legal/versions.ts`).

Skutek do pamiętania: kto zgodzi się dopiero po rejestracji, nie ma `signup_completed`
ani źródła w PostHogu, ale kolejne zdarzenia już ma. Stąd w lejku PostHoga krok 1 bywa
mniejszy od kroku 2 przy porządku „dowolny”, a `/admin` tego problemu nie ma.

## Zdarzenia lejka

Każde niesie `tenant_id` i grupę `tenant` (poza `signup_completed`, gdzie firmy jeszcze
nie ma) oraz `source`, jeśli znamy źródło. Kwot i numerów faktur nie wysyłamy.

| Zdarzenie | Kiedy | Skąd | Właściwości | Klucz uuid | `timestamp` |
|---|---|---|---|---|---|
| `signup_completed` | nowe konto: formularz hasła albo pierwsze logowanie Google (konto młodsze niż 10 min, dostawca `google`). Nie: ponowne logowanie Google, zajęty adres, potwierdzenie e-maila | `register/actions.ts`, `auth/callback/route.ts` | `method`: `password`, `google` | użytkownik | `created_at` konta |
| `ksef_configured` | pierwsze skuteczne podłączenie: wynik `claimed` z `finalize_ksef_certificate_claim`. Nie: wymiana certyfikatu | `components/settings/actions.ts` | `env` | firma | chwila wysłania |
| `first_invoice_sent` | pierwsza faktura firmy przyjęta w KSeF: warunkowy UPDATE `tenants.first_invoice_accepted_at … WHERE IS NULL`. Nie: faktury zakupu, sprzedaż pobrana z historii KSeF | `jobs/runners/submit-invoice.ts` | `ksef_env` | firma | przyjęcie w KSeF |
| `trial_started` | start próby: `customer.subscription.created` z `trial_start` | `stripe/webhook-handlers.ts` | `trial_days` | firma | `trial_start` |
| `payment_succeeded` | prawdziwa płatność powyżej 0 zł. Nie: faktura 0 zł z próby | jw. | `first_payment`: true, gdy to pierwsza wpłata firmy | faktura Stripe | `paid_at` |
| `subscription_canceled` | koniec subskrypcji po co najmniej jednej płatności, powód inny niż płatność | jw. | `reason`: `canceled` | subskrypcja | koniec subskrypcji |
| `payment_churn` | koniec subskrypcji po płatnościach, powód Stripe `payment_failed` albo `payment_disputed` | jw. | `reason`: `payment_failed` | subskrypcja | koniec subskrypcji |
| `trial_ended` | koniec subskrypcji z próbą bez żadnej płatności, także rezygnacja w trakcie próby i nieudane pierwsze obciążenie | jw. | `reason`: `trial_no_payment`, `converted`: false | subskrypcja | koniec subskrypcji |

`first_payment` nie pojawia się, gdy odczyt historii płatności się nie udał: płatność
była, nie znamy tylko flagi. Przejście z próby do płacenia widać po
`payment_succeeded` z `first_payment = true`, osobnego zdarzenia nie ma.

Warunek po stronie Stripe: `payment_churn` działa tylko, gdy po nieudanych próbach
subskrypcja jest **anulowana** (Stripe Dashboard → Settings → Billing → Subscriptions
and emails → „Cancel the subscription”). Przy „leave as past due” albo „mark as unpaid”
webhook `deleted` nie przyjdzie i odejścia nie zobaczysz ani tu, ani w `/admin`.

## Dokładnie raz

Worker pg-boss powtarza cały handler, a Stripe ponawia webhook po każdym 500.

- **Deterministyczny uuid** (`dedupeKey` w `trackServer`): UUID v8 z SHA-256 nazwy zdarzenia
  i klucza z tabeli wyżej. Ponowienie wysyła ten sam uuid. Nie v5, bo ta wersja oznacza SHA-1,
  a na to odpowiada czerwonym alertem CodeQL.
- **SDK nie deduplikuje.** `posthog-node` tylko przekazuje `uuid` do paczki (bez niego
  nadaje świeży uuidv7), co sprawdza test `analytics-bramka-zgody` na prawdziwym kliencie
  z podstawionym `fetch`. Skleja magazyn PostHoga po kluczu (data z `timestamp`, nazwa,
  `distinct_id`, uuid). Dlatego ponawialne zdarzenia niosą też `timestamp` z prawdziwej
  chwili: ponowienie następnego dnia trafia w ten sam klucz. To zachowanie po stronie
  PostHoga, testów nie da się na nim oprzeć bez konta (patrz „Po wdrożeniu”).
- **Warunek w bazie** tam, gdzie „pierwszy” musi rozstrzygnąć wyścig: `first_invoice_accepted_at`.
  Awaria po wygranym UPDATE nie gubi zdarzenia: ta sama chwila w firmie i na fakturze
  znaczy „to ja wygrałem” i wysyłka idzie jeszcze raz z tym samym uuid.

## Źródło wejścia

Przed zgodą adres z chwili wejścia leży wyłącznie w pamięci karty. Kliknięcie „Akceptuję”
na stronie publicznej tworzy ciasteczko `ff_first_touch` (własne, najdłużej 90 dni,
`SameSite=Lax`). Pierwszy dotyk się nie nadpisuje.

Dla anonimowego gościa to ciasteczko jest też dowodem zgody przy rejestracji, bo localStorage
serwer nie widzi. Dlatego dowodzi wyłącznie wyboru, który nie dotarł jeszcze na konto:

- rejestracja je zużywa: zostaje sam znacznik `delivered` bez danych, a przeglądarka przy
  następnej stronie albo synchronizacji uznaje wybór za dostarczony i sprząta;
- dostarczenie wyboru na konto i odwołanie kasują je od razu;
- przy starcie strony nie powstaje, więc 90 dni to prawdziwy limit tego dowodu.

Dzięki temu kolejna osoba przy wspólnym komputerze nie dostaje cudzego „tak” ani cudzego źródła.
Została jedna luka, której przeglądarka nie zamknie: gość A kliknął „Akceptuję” i nie założył
konta, a konto zakłada B, zanim ciasteczko wygaśnie. Serwer nie odróżni A od B.

Zapisywane pola (`FirstTouch` w `privacy.ts`): `channel`, `utm_source`, `utm_medium`,
`utm_campaign`, `utm_term`, `utm_content`, `referrer_host` (sam host), `landing_path`
(tylko strony publiczne), `at` (data). Wartość utm z `@`, siedmioma cyframi z rzędu albo
znakami spoza listy odpada. Identyfikatorów kliknięć nie zapisujemy; ich obecność
wskazuje tylko kanał.

| Kanał (`source`) | Kiedy |
|---|---|
| `google_ads` | `gclid`, `gbraid`, `wbraid` w adresie albo `utm_source` google/adwords z płatnym `utm_medium` |
| `organic_search` | odsyłacz z wyszukiwarki, `utm_medium=organic`, `utm_source` wyszukiwarki bez płatnego medium |
| `youtube` | `utm_source` youtube/yt albo odsyłacz youtube.com, youtu.be |
| `tiktok` | `ttclid`, `utm_source` tiktok/tt albo odsyłacz tiktok.com |
| `social` | `fbclid`, `utm_medium=social`, `utm_source` serwisu społecznościowego, odsyłacz z takiego serwisu (także Wykop) |
| `referral` | odsyłacz z innej strony, `utm_medium` referral/affiliate/partner |
| `direct` | brak odsyłacza, własna domena, powrót z logowania Google albo płatności Stripe |
| `other` | utm, którego nie umiemy przypisać; płatne kampanie spoza Google i serwisów społecznościowych |

Dopisując kampanię, ustaw `utm_source` i `utm_medium` zgodnie z tabelą, inaczej trafi do `other`.

## Właściwości osoby

| Właściwość | Sposób | Wartość |
|---|---|---|
| `first_touch_channel`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `referrer_host`, `landing_path`, `first_touch_at` | `$set_once` na zdarzeniach lejka | pierwszy dotyk, surowe dane wejścia |
| `plan` | `$set` | `trial`, `active`, `canceled` |

Do zdarzeń idzie tylko znormalizowany kanał `source`. Właściwości osoby jadą w `properties`
zdarzenia: SDK ignoruje `$set` podane obok `properties`, przez co do 11.2026 `plan` nie
docierał nigdy.

## Definicja lejka w PostHogu

Project: FaktWay, region EU. Zrób to po pierwszych zdarzeniach, wtedy nazwy podpowiadają się same.

**Lejek główny**

1. Product analytics → **New insight** → zakładka **Funnels**.
2. Kroki, w tej kolejności:
   1. `signup_completed`
   2. `ksef_configured`
   3. `first_invoice_sent`
   4. `trial_started`
   5. `payment_succeeded` z filtrem właściwości zdarzenia `first_payment` = `true`
3. **Aggregating by:** Unique users. Zdarzenia firmy idą na właściciela, więc to ta sama osoba.
4. **Conversion window:** 60 dni (30 dni próby plus czas na podłączenie KSeF).
5. **Step order:** Sequential. Kto zaczął próbę przed podłączeniem KSeF, wypadnie z tego
   widoku: przełącz na **Any order**, żeby zobaczyć, ilu takich jest.
6. **Breakdown:** właściwość zdarzenia `source` (kanał) albo właściwość osoby
   `first_touch_channel`. Kampanie: właściwość osoby `utm_campaign`.
7. Zakres: ostatnie 90 dni. **Save** jako „Lejek FaktWay: główny”.

**Odejścia**

1. **New insight** → **Trends**.
2. Serie: `subscription_canceled`, `payment_churn`, `trial_ended`. Interwał: tydzień.
3. **Breakdown:** `source`. **Save** jako „Lejek FaktWay: odejścia”.

**Do czasu aktywacji**

1. Lejek główny, kopia, tylko kroki `signup_completed` → `first_invoice_sent`.
2. Widok wykresu: **Time to convert**. **Save** jako „Lejek FaktWay: do pierwszej faktury”.

Odfiltruj własne konta: Project settings → **Filter out internal and test users**
(właściwość osoby albo cohort z testowymi id).

## Lejek zbiorczy w `/admin`

`admin_funnel_weekly(p_weeks)`, tylko `service_role`, zakres przycinany do 1–52 tygodni.
Każda firma liczy się w tygodniu założenia (poniedziałek, czas Warszawy), więc świeże
tygodnie jeszcze dojrzewają: tygodnia sprzed trzech dni nie porównuj z tym sprzed trzech miesięcy.

| Kolumna | Definicja |
|---|---|
| Nowe | `tenants.created_at` w tym tygodniu |
| KSeF | `ksef_verified_at` ustawione |
| Faktura | `first_invoice_accepted_at` ustawione |
| Próba | subskrypcja z `trial_start` |
| Płacący | płatność `amount_cents > 0` (także później zwrócona) |
| Odeszli | subskrypcja `canceled` i żadnej trwającej |

Wiersz `source = 'all'` nie zależy od zgód. Wiersze kanałów obejmują tylko firmy, których
właściciel ma zgodę, i znikają od razu po jej odwołaniu.

## Po wdrożeniu

```sql
-- Czy uzupełnienie objęło firmy z przyjętymi fakturami (oczekiwane: 0)
SELECT count(*) FROM public.tenants t
 WHERE t.first_invoice_accepted_at IS NULL
   AND EXISTS (SELECT 1 FROM public.invoices i WHERE i.tenant_id = t.id
                AND i.direction = 'outgoing' AND i.ksef_status = 'accepted' AND i.origin = 'app');

-- Ile zgód i źródeł
SELECT analytics_consent, count(*), count(signup_source) FROM public.users GROUP BY 1;

-- Lejek jak w panelu
SELECT * FROM public.admin_funnel_weekly(4);
```

W PostHogu (Activity → Live events), na koncie ze zgodą: zarejestruj konto i sprawdź
`signup_completed` z `source`; w **Persons** właściwości `first_touch_channel` i `plan`.
Ponów webhook `customer.subscription.created` ze Stripe Dashboard i sprawdź w SQL insightach,
że `SELECT uuid, count() FROM events WHERE event = 'trial_started' GROUP BY uuid` daje po
scaleniu jeden wiersz na uuid. Odwołaj zgodę w ustawieniach i sprawdź, że kolejne zdarzenia
tego konta już nie przychodzą.
