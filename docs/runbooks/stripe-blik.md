# BLIK cykliczny obok karty przy próbie

Klient zaczyna 30 dni próby kartą albo BLIK-iem. Domyślnie wyłączone: bez zmiennej
`STRIPE_BLIK_RECURRING=on` aplikacja wysyła do Stripe dokładnie to samo żądanie co przed BLIK-iem
(pilnuje tego `tests/unit/stripe-checkout-blik.test.ts`).

Źródła (sprawdzone 02.11.2026): [BLIK recurring payments](https://docs.stripe.com/payments/blik/recurring-payments),
[tworzenie Checkout Session w 2026-09-30.endive](https://docs.stripe.com/api/checkout/sessions/create?api-version=2026-09-30.endive),
[usunięcie `payment_method_types`](https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions).

## Najważniejsze: kolejność

**Najpierw zmienna, potem Dashboard. Przy wycofaniu odwrotnie.**

Przy wyłączonym przełączniku aplikacja nie podaje listy metod, więc Stripe bierze je z Dashboardu.
Aktywny tam BLIK cykliczny może się pojawić w Checkout bez naszych ujawnień (zgoda, 0 zł dziś, data
pierwszego obciążenia, banki), których Stripe wymaga przed kodem BLIK. Odwrotna kolejność jest
bezpieczna: przy włączonej zmiennej i nieaktywnym BLIK-u Stripe po prostu pokazuje samą kartę, a my
dostajemy sygnał w Sentry. Przy włączonej zmiennej lista metod zawsze idzie w żądaniu: strona bez aktualnych
ujawnień (stara karta, inne brzmienie zgody) dostaje jawnie samą kartę.

## Zanim zaczniesz

1. Stripe działa na tym środowisku: `STRIPE_SECRET_KEY`, webhook, `STRIPE_PRICE_MONTHLY` w **PLN**
   (BLIK cykliczny to tylko PLN, do 2000 zł na obciążenie).
2. Migracja `00162` na bazie, przed wdrożeniem kodu (`AGENTS.md`, „Wgrywanie migracji”). Bez niej
   faktura za abonament opłacony BLIK-iem dostanie odmowę `Billing VAT identity/date requires reconciliation`.
3. **Wersja zdarzeń webhooka: przed `2025-03-31.basil`, u nas `2024-11-20.acacia`.** Webhook czyta
   `invoice.payment_intent` i `invoice.charge`, których od basil nie ma, a wersję zdarzeń ustawia się na samym
   endpoincie, niezależnie od wersji klienta w kodzie (`docs/security/STRIPE-PARA-PI-CHARGE-ODBIOR-2026-09-25.md`).
   Przy nowszej koniec próby się nie uda: `invoice.payment_succeeded` kończy się
   `Stripe invoice payment reference missing or invalid`, bez wiersza `succeeded` i bez faktury, a
   `invoice.payment_failed` traci kod odmowy, więc klient dostaje tekst ogólny. Sprawdzenie:
   - produkcja: `./scripts/ops/stripe-blik-sprawdz.sh`,
   - tryb testowy: `stripe get /v1/webhook_endpoints` (pole `api_version`, puste oznacza domyślną wersję konta)
     i `stripe get /v1/events --limit 1` (pole `api_version` zdarzenia).
4. **Regulamin mówi dziś o karcie** (`lib/legal/documents/regulamin.ts`: „dane karty płatniczej”,
   „obciążania karty”). Przed włączeniem na produkcji zmień go z prawnikiem: nowa `CONTRACT_VERSION`
   i powiadomienie z wyprzedzeniem (§ 15). Dotyczy też `lib/legal/subprocessors.ts` i polityki prywatności.
5. Portal klienta: Dashboard → Settings → Billing → Customer portal, opcja **Payment methods** włączona
   (domyślnie jest). To nasza ścieżka zmiany metody po odmowie. Portal bierze metody z domyślnej
   konfiguracji metod płatności, więc BLIK pojawi się tam po kroku z Dashboardem. Ustaw też
   **Terms of service link** na regulamin: portal pokazuje go przy dodawaniu metody. Warunki BLIK-a (ramka
   „Zmieniasz metodę płatności na BLIK?”) pokazuje strona abonamentu przy przycisku portalu, w samym portalu ich nie ma.
6. Dashboard → Billing, ustawienia nieudanych płatności (**Manage failed payments**): po wyczerpaniu prób wybierz
   `unpaid` albo `canceled`. Strona abonamentu przy `past_due` mówi o kolejnej próbie, a przy `unpaid` każe opłacić
   fakturę w portalu, więc zostawienie `past_due` po ostatniej próbie obiecywałoby pobranie, którego nie będzie.

## Włączenie w trybie testowym

1. Ustaw zmienną lokalnie w `.env.local`: `STRIPE_BLIK_RECURRING=on` i klucz `sk_test_…`, uruchom aplikację.
2. Dashboard (tryb testowy) → Settings → [Payment methods](https://dashboard.stripe.com/settings/payment_methods)
   → BLIK → włącz płatności cykliczne. Gdy nie ma tej opcji, napisz do [wsparcia Stripe](https://support.stripe.com/contact):
   changelog z kwietnia wymagał włączenia na koncie przez wsparcie. Uwaga: telekomunikacja, przekazy pieniężne,
   maklerzy, ubezpieczenia i hazard nie kwalifikują się, FaktWay do tych grup nie należy.
3. Sprawdź, czy oba `capabilities` są `active` (`blik_payments`, `blik_recurring_payments`): Dashboard albo
   `stripe get /v1/account` ze Stripe CLI (pole `capabilities`). Na produkcji robi to skrypt z sekcji niżej.
4. Webhooki lokalnie: `stripe listen --forward-to localhost:3000/api/stripe/webhook`. Na starcie CLI wypisuje
   wersję zdarzeń („You are using Stripe API Version [...]”). To domyślna wersja konta, a z `--latest` najnowsza;
   `--load-from-webhooks-api` bierze z endpointów tylko adresy i listę zdarzeń, wersji nie. Gdy to wersja od basil
   wzwyż, `stripe listen` nie nadaje się do testu końca próby. Załóż wtedy przez API endpoint z przypiętą wersją
   (Dashboard ustawia tylko najnowszą), na adres tunelu do `localhost:3000`, a jego sekret wpisz do
   `STRIPE_WEBHOOK_SECRET`:
   ```bash
   stripe post /v1/webhook_endpoints -d url=https://ADRES-TUNELU/api/stripe/webhook -d api_version=2024-11-20.acacia -d "enabled_events[]=*"
   ```

## Testy symulacji

Stripe wybiera scenariusz po adresie e-mail płatnika. Checkout bierze go z klienta Stripe (u nas: e-mail
osoby, która startuje próbę) i nie pozwala go zmienić, więc zakładasz konto testowe z takim adresem, np.
`test+recurring_not_supported@example.test`. Koniec próby wymuszasz: Dashboard → subskrypcja → zakończ
trial albo `stripe subscriptions update sub_… --trial-end now`.

| Adres e-mail zawiera | Co robi Stripe | Co ma się stać u nas |
|---|---|---|
| `recurring_not_supported@` | od razu odmowa `payment_method_provider_decline` / `recurring_not_supported_by_bank` przy zakładaniu mandatu | Checkout zostaje otwarty, klient wybiera kartę. Powrót: baner z podpowiedzią „inny bank albo karta”, ta sama Session |
| `setup_timeout@` | po 60 s `mandate.updated` (pending → inactive) | subskrypcja nie powstaje, Session można dokończyć kartą albo wygasa |
| `recurring_declined@` | mandat działa, każde obciążenie odrzucone (`generic_decline`) | `stripe_payments.failure_reason = generic_decline`, mail z tekstem ogólnym „zmień metodę płatności” |
| `alias_declined@` | obciążenie odrzucone i mandat cofnięty | jak wyżej, kolejne próby też się nie udadzą |
| `alias_unregistered@`, `alias_expired@` | po 6 min `mandate.updated` (active → inactive) | nic od razu; najbliższe obciążenie kończy się odmową i mailem |
| `insufficient_funds@`, `limit_exceeded@`, `customer_declined@`, `bank_declined@` | odmowa z tym kodem po ok. 8 s | mail mówi, co zrobić przy tym kodzie (`lib/billing/payment-failure.ts`) |

Kod odmowy aplikacja czyta z PaymentIntent w wersji endive, bo starsze dostają `generic_decline` zamiast kodu
szczegółowego. Ostatni wiersz tabeli to wzorce z płatności jednorazowych: dokumentacja nie mówi, czy działają na
obciążeniu po próbie. Jeśli odmowa przyjdzie już przy zakładaniu mandatu, Checkout pokaże błąd i subskrypcji nie
będzie. Teksty dla tych kodów sprawdza też `tests/unit/stripe-payment-decline.test.ts`.

Do tego ścieżka bez adresu specjalnego. W sandboxie działa dowolny kod sześciocyfrowy, np. `123456`:

1. Strona `/settings/billing` pokazuje przed przyciskiem: 0 zł dziś, datę pierwszej płatności, cykl, listę
   banków i zgodę w polu wyboru.
2. Po kodzie BLIK i zatwierdzeniu subskrypcja jest w statusie `trialing`, bez wiersza w `stripe_payments`.
3. Koniec próby: wiersz `succeeded` w `stripe_payments`, faktura za abonament z `FormaPlatnosci` 7
   i napisem „Płatność mobilna” na PDF.
4. Przy subskrypcji strona pokazuje przy przycisku „Zarządzaj subskrypcją” ramkę z warunkami: 0 zł przy dodaniu,
   następną płatność, cykl, banki i zgodę. Przy wyłączonej zmiennej ramki nie ma.
5. Portal pozwala zmienić BLIK na kartę i kartę na BLIK.

## Włączenie na produkcji

1. Migracja `00162`, potem wdrożenie (kolejność z `AGENTS.md`).
2. Coolify, aplikacja `id=1` (Next.js): `STRIPE_BLIK_RECURRING=on`, wiersz `is_preview = false`. Worker
   tej zmiennej nie czyta. Zmiana wymaga wdrożenia aplikacji.
   **Zmienna musi być dostępna także przy budowaniu** (w Coolify oznacz ją jako „Build Variable”, tak jak
   zmienne `NEXT_PUBLIC_*`), a zmiana wymaga **pełnego wdrożenia z nowym buildem**, nie samego restartu
   kontenera. Powód: strona główna i cennik są budowane statycznie, a tekst o metodzie płatności („karta
   przy starcie” albo „karta albo BLIK przy starcie”, `lib/marketing/oferta.ts`) powstaje przy `next build`
   z `trialPaymentMethodLabel()`. Po samym restarcie panel `/settings/billing` (renderowany na żądanie)
   pokazałby już BLIK-a, a strony publiczne wciąż obiecywałyby samą kartę.
3. Dashboard (tryb live): włącz BLIK i płatności cykliczne jak wyżej. Stripe aktywuje to z opóźnieniem,
   do tego czasu klienci widzą samą kartę.
4. Sprawdź zmienną, `capabilities` i wersję zdarzeń webhooka jedną linią (tylko odczyt):
   ```bash
   ./scripts/ops/stripe-blik-sprawdz.sh
   ```
5. Sprawdź, że strony publiczne mówią to samo co panel (obie linie mają wypisać trafienie):
   ```bash
   curl -s https://faktway.pl/ | grep -o 'karta albo BLIK przy starcie' | head -1
   curl -s https://faktway.pl/pricing | grep -o 'karta albo BLIK przy starcie' | head -1
   ```
   Brak trafienia znaczy, że zmienna nie była dostępna przy budowaniu (Dockerfile deklaruje `ARG` tylko dla
   `NEXT_PUBLIC_*`, więc sprawdź w logu budowania, czy Coolify przekazał także tę zmienną) albo że
   wdrożenie było tylko restartem.
6. Test na własnym koncie w banku z listy: start próby, potem anulowanie w portalu.

## Co obserwować

- **Sentry, tag `area:billing.checkout.blik`.** Ostrzeżenie „offered no BLIK”: konto nie ma aktywnego BLIK-a
  i Stripe go odfiltrował. Wyjątek: Stripe odrzucił żądanie (400 albo 403), próba poszła samą kartą.
- **Audyt `billing.checkout.blik_unavailable`** (`metadata.reason`: `filtered` albo `refused`):
  ```sql
  SELECT created_at, metadata->>'reason', metadata->>'stripeCode', metadata->>'stripeParam'
  FROM audit_logs WHERE action = 'billing.checkout.blik_unavailable'
  ORDER BY created_at DESC LIMIT 20;
  ```
  W wierszu `filtered` pole `metadata->'offeredPaymentMethods'` mówi, co Stripe pokazał klientowi.
- **Ile startów z ofertą BLIK-a:** wiersze audytu `legal.checkout_statement_accepted` z
  `metadata->>'blikStatementVersion'` (dowód zgody). Porównaj z liczbą wierszy `blik_unavailable` z tego
  samego okresu: różnica to starty, przy których Checkout pokazał BLIK.
- **Otwarcia portalu po pokazaniu warunków:** audyt `billing.checkout.session_created` z `entity_type = 'stripe_portal'`
  i `metadata->>'blikStatementVersion'`. To ślad pokazania warunków, nie zaznaczona zgoda: przy portalu nie ma pola
  wyboru, bo ten sam przycisk służy do anulowania.
- **Odmowy obciążeń:**
  ```sql
  SELECT failure_reason, count(*) FROM stripe_payments
  WHERE status = 'failed' AND created_at > now() - interval '30 days'
  GROUP BY 1 ORDER BY 2 DESC;
  ```
  Dużo `recurring_not_supported_by_bank` oznacza, że lista banków na stronie nie wystarcza.
- **Sentry, tag `area:billing.payment_failed.decline_lookup`:** odczyt PaymentIntent się nie udał. Płatność
  i mail poszły dalej z tekstem ogólnym.
- **Próby w stanie `uncertain`** (`stripe_checkout_attempts`): tylko wynik niepewny, jak przed BLIK-iem.
  Odmowa Stripe tam nie trafia.
- W Dashboardzie: `mandate.updated` (klient usunął BLIK w banku). Aplikacja tego zdarzenia nie obsługuje,
  dowiaduje się przy najbliższym obciążeniu.
- **Anulowanie subskrypcji kończy pobrania, ale nie mandat.** Alias zostaje w Stripe i w aplikacji banku klienta, bo
  mandat kończy dopiero odpięcie metody albo cofnięcie w banku, a kod niczego nie odpina. Tak mówi też treść zgody.
  Klient pyta o alias: cofa go w aplikacji banku albo operator usuwa metodę u klienta w Dashboardzie.

## Zwroty i spory

Zwrot: do 13 miesięcy od płatności według instrukcji BLIK-a (strona metody podaje 730 dni, licz 13). Spór: klient
zgłasza go w banku do 13 miesięcy, na dowody masz 12 dni, a od decyzji nie ma odwołania. Reszta:
`docs/runbooks/refund-and-disputes.md`.

**Zwrot BLIK-a z panelu admina zawsze kończy się stanem do uzgodnienia.** Zwroty BLIK-a są asynchroniczne: Stripe
odpowiada `pending`, a wynik końcowy daje do 120 minut później (`refund.updated` albo `refund.failed`). `issueRefund`
każdy stan inny niż `succeeded` zapisuje jako `reconciliation_required` (powód `stripe_status_pending`), a webhook
tylko zapisuje sprawę finansową. Panel wysyła zwrot do Stripe wyłącznie dla płatności bez faktury VAT, więc to rzadki
przypadek. Tutaj to normalny przebieg, nie awaria:

- admin widzi „Nie można potwierdzić wyniku zwrotu”,
- monitor wysyła alarm krytyczny „Zwroty Stripe wymagają uzgodnienia” i będzie go ponawiał do domknięcia,
- `stripe_refunds.status` zostaje `pending`, a `stripe_payments.status` zostaje `succeeded`,
- mail `RefundIssued` nie wychodzi.

Co zrobić:

1. Nie klikaj zwrotu drugi raz i nie rób go w Dashboardzie. Identyfikator zwrotu:
   `SELECT stripe_refund_id, reconciliation_reason FROM stripe_refund_operations WHERE payment_id = '…';`
2. Po 120 minutach sprawdź go w Stripe: `stripe get re_…`, pole `status`.
3. `failed`: pieniądze wróciły na saldo Stripe, a klientowi trzeba je oddać inną drogą. Operacja zostaje do decyzji
   (`docs/runbooks/refund-and-disputes.md`).
4. `succeeded`: za zgodą Bartosza domknij stan na `db-1` poniższym blokiem (podaj `v_payment` i `v_refund`). Wykonuje
   się w całości albo wcale, a warunki odmawiają, gdy stan jest inny niż opisany wyżej:
   ```sql
   DO $$
   DECLARE
     v_payment CONSTANT uuid := 'ID-PLATNOSCI';
     v_refund CONSTANT text := 'ID-ZWROTU-RE';
     v_refund_row uuid;
     v_tenant uuid;
     v_settled text;
   BEGIN
     UPDATE public.stripe_refunds SET status = 'succeeded'
       WHERE payment_id = v_payment AND stripe_refund_id = v_refund AND status = 'pending'
       RETURNING id, tenant_id INTO STRICT v_refund_row, v_tenant;
     PERFORM 1 FROM public.stripe_refund_operations
       WHERE payment_id = v_payment AND stripe_refund_id = v_refund AND status = 'reconciliation_required'
       FOR UPDATE;
     IF NOT FOUND THEN RAISE EXCEPTION 'Operacja zwrotu nie czeka na uzgodnienie'; END IF;
     UPDATE public.stripe_payments SET status = 'refunded'
       WHERE id = v_payment AND status = 'succeeded';
     IF NOT FOUND THEN RAISE EXCEPTION 'Płatność nie jest w stanie succeeded'; END IF;
     UPDATE public.stripe_refund_operations
       SET status = 'completed', refund_id = v_refund_row, updated_at = now()
       WHERE payment_id = v_payment;
     v_settled := public.settle_admin_refund_case(v_payment, v_refund);
     IF v_settled NOT IN ('settled', 'missing_case') THEN
       RAISE EXCEPTION 'Sprawa finansowa: %', v_settled;
     END IF;
     INSERT INTO public.audit_logs (tenant_id, action, entity_type, entity_id, metadata)
     VALUES (v_tenant, 'billing.refund.issued', 'stripe_refund', v_refund_row, jsonb_build_object(
       'paymentId', v_payment, 'stripeRefundId', v_refund, 'source', 'runbook-stripe-blik'
     ));
     RAISE NOTICE 'Domknięte, sprawa finansowa: %', v_settled;
   END $$;
   ```
   `Sprawa finansowa: needs_reconciliation` znaczy, że webhook nie zapisał jeszcze `succeeded` albo kwota się nie
   zgadza: nic się nie zmieniło, sprawdź `stripe_financial_cases` i ponów po dostawie zdarzenia.
5. Napisz do klienta, że zwrot wykonano: mail `RefundIssued` na tej ścieżce nie wychodzi.

## Wycofanie

1. Dashboard: wyłącz BLIK (najpierw to, zobacz „Najważniejsze: kolejność”).
2. Coolify: pusta `STRIPE_BLIK_RECURRING`, wdrożenie aplikacji (pełne, z nowym buildem, jak przy włączeniu:
   inaczej strona główna i cennik zostają przy „karta albo BLIK”). Strona wraca do samej karty.
3. Otwarte Session z BLIK-iem żyją do 24 h i aplikacja dalej je podaje klientowi, który wróci. Pilne: wygaś je
   przez API, jedną linią. Bez argumentu skrypt tylko je pokazuje, a przy włączonej zmiennej niczego nie wygasi:
   ```bash
   ./scripts/ops/stripe-blik-wygas-sesje.sh --wygas
   ```
   Klient otwierający wygaszoną Session widzi komunikat Stripe, a kolejny klik w aplikacji zakłada nową, już bez
   BLIK-a. W trybie testowym: `stripe post /v1/checkout/sessions/cs_test_…/expire`.
4. Subskrypcji już założonych z BLIK-iem nic nie zmienia, mandat działa dalej. Żeby ich nie obciążać,
   poproś klientów o zmianę metody w portalu.

## Jak to działa w kodzie

- Przełącznik i napisy: `lib/billing/trial-payment.ts` (`isBlikAvailable`, `trialPaymentMethodLabel`,
  `buildBlikDisclosure`). Zgoda z wersją: `BLIK_RECURRING_STATEMENT` w `lib/legal/versions.ts`, dowód w audycie
  `legal.checkout_statement_accepted`.
- Żądanie: `lib/stripe/checkout.ts`. Wersja `2026-09-30.endive` (`lib/stripe/blik-api-version.ts`) tylko na to
  żądanie i na odczyt kodu odmowy, globalna `2024-11-20.acacia` zostaje (od niej zależą kształty obiektów). W endive
  `payment_method_types` przy tworzeniu
  Session daje 400, więc idzie `allowed_payment_method_types`, którego typy stripe-node 22.1.1 nie znają.
  Ten parametr to filtr: BLIK nieaktywny znika bez błędu, stąd sprawdzenie `payment_method_types` w odpowiedzi.
- Klucze idempotencji: `faktflow-checkout-v2:` (przełącznik wyłączony, jak dotąd), `faktflow-checkout-blik-v1:`,
  `faktflow-checkout-card-v1:` (jawnie sama karta: strona bez aktualnych ujawnień albo ponowienie po odmowie).
  Mandat bez `expires_at`, czyli bezterminowy.
- Kody odmów na tekst: `lib/billing/payment-failure.ts` (status `unpaid` ma własne działanie, bo Stripe już nie
  pobiera); kod czyta `lib/stripe/payment-decline.ts`.
- Faktura: `lib/billing/self-invoice.ts`, metoda `mobile`, RPC z migracji `00162`.
