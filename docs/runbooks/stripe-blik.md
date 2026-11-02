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
dostajemy sygnał w Sentry.

## Zanim zaczniesz

1. Stripe działa na tym środowisku: `STRIPE_SECRET_KEY`, webhook, `STRIPE_PRICE_MONTHLY` w **PLN**
   (BLIK cykliczny to tylko PLN, do 2000 zł na obciążenie).
2. Migracja `00158` na bazie, przed wdrożeniem kodu (`AGENTS.md`, „Wgrywanie migracji”). Bez niej
   faktura za abonament opłacony BLIK-iem dostanie odmowę `Billing VAT identity/date requires reconciliation`.
3. **Regulamin mówi dziś o karcie** (`lib/legal/documents/regulamin.ts`: „dane karty płatniczej”,
   „obciążania karty”). Przed włączeniem na produkcji zmień go z prawnikiem: nowa `CONTRACT_VERSION`
   i powiadomienie z wyprzedzeniem (§ 15). Dotyczy też `lib/legal/subprocessors.ts` i polityki prywatności.
4. Portal klienta: Dashboard → Settings → Billing → Customer portal, opcja **Payment methods** włączona
   (domyślnie jest). To nasza ścieżka zmiany metody po odmowie. Portal bierze metody z domyślnej
   konfiguracji metod płatności, więc BLIK pojawi się tam po kroku z Dashboardem.

## Włączenie w trybie testowym

1. Ustaw zmienną lokalnie w `.env.local`: `STRIPE_BLIK_RECURRING=on` i klucz `sk_test_…`, uruchom aplikację.
2. Dashboard (tryb testowy) → Settings → [Payment methods](https://dashboard.stripe.com/settings/payment_methods)
   → BLIK → włącz płatności cykliczne. Gdy nie ma tej opcji, napisz do [wsparcia Stripe](https://support.stripe.com/contact):
   changelog z kwietnia wymagał włączenia na koncie przez wsparcie. Uwaga: telekomunikacja, przekazy pieniężne,
   maklerzy, ubezpieczenia i hazard nie kwalifikują się, FaktWay do tych grup nie należy.
3. Sprawdź, czy oba `capabilities` są `active` (`blik_payments`, `blik_recurring_payments`). Dashboard albo:
   ```bash
   curl -s https://api.stripe.com/v1/account -u "$STRIPE_SECRET_KEY:" -H "Stripe-Version: 2026-09-30.endive"
   ```
   Na produkcji robi to skrypt z sekcji niżej.
4. Webhooki lokalnie: `stripe listen --forward-to localhost:3000/api/stripe/webhook`.

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

Do tego ścieżka bez adresu specjalnego, kod BLIK wg [dokumentacji](https://docs.stripe.com/payments/blik/accept-a-payment):

1. Strona `/settings/billing` pokazuje przed przyciskiem: 0 zł dziś, datę pierwszej płatności, cykl, listę
   banków i zgodę w polu wyboru.
2. Po kodzie BLIK i zatwierdzeniu subskrypcja jest w statusie `trialing`, bez wiersza w `stripe_payments`.
3. Koniec próby: wiersz `succeeded` w `stripe_payments`, faktura za abonament z `FormaPlatnosci` 7
   i napisem „Płatność mobilna” na PDF.
4. Portal („Zarządzaj subskrypcją”) pozwala zmienić BLIK na kartę i kartę na BLIK.

## Włączenie na produkcji

1. Migracja `00158`, potem wdrożenie (kolejność z `AGENTS.md`).
2. Coolify, aplikacja `id=1` (Next.js): `STRIPE_BLIK_RECURRING=on`, wiersz `is_preview = false`. Worker
   tej zmiennej nie czyta. Zmiana wymaga wdrożenia aplikacji.
3. Dashboard (tryb live): włącz BLIK i płatności cykliczne jak wyżej. Stripe aktywuje to z opóźnieniem,
   do tego czasu klienci widzą samą kartę.
4. Sprawdź zmienną i `capabilities` jedną linią (tylko odczyt):
   ```bash
   ./scripts/ops/stripe-blik-sprawdz.sh
   ```
5. Test na własnym koncie w banku z listy: start próby, potem anulowanie w portalu.

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

## Wycofanie

1. Dashboard: wyłącz BLIK (najpierw to, zobacz „Najważniejsze: kolejność”).
2. Coolify: pusta `STRIPE_BLIK_RECURRING`, wdrożenie aplikacji. Strona wraca do samej karty.
3. Otwarte Session z BLIK-iem żyją do 24 h i aplikacja dalej je podaje klientowi, który wróci. Pilne: wygaś je w Dashboardzie.
4. Subskrypcji już założonych z BLIK-iem nic nie zmienia, mandat działa dalej. Żeby ich nie obciążać,
   poproś klientów o zmianę metody w portalu.

## Jak to działa w kodzie

- Przełącznik i napisy: `lib/billing/trial-payment.ts` (`isBlikAvailable`, `trialPaymentMethodLabel`,
  `buildBlikDisclosure`). Zgoda z wersją: `BLIK_RECURRING_STATEMENT` w `lib/legal/versions.ts`, dowód w audycie
  `legal.checkout_statement_accepted`.
- Żądanie: `lib/stripe/checkout.ts`. Wersja `2026-09-30.endive` tylko na to jedno żądanie, globalna
  `2024-11-20.acacia` zostaje (od niej zależą kształty obiektów). W endive `payment_method_types` przy tworzeniu
  Session daje 400, więc idzie `allowed_payment_method_types`, którego typy stripe-node 22.1.1 nie znają.
  Ten parametr to filtr: BLIK nieaktywny znika bez błędu, stąd sprawdzenie `payment_method_types` w odpowiedzi.
- Klucze idempotencji: `faktflow-checkout-v2:` (sama karta, jak dotąd), `faktflow-checkout-blik-v1:`,
  `faktflow-checkout-card-v1:` (ponowienie po odmowie). Mandat bez `expires_at`, czyli bezterminowy.
- Kody odmów na tekst: `lib/billing/payment-failure.ts`; kod czyta `lib/stripe/payment-decline.ts`.
- Faktura: `lib/billing/self-invoice.ts`, metoda `mobile`, RPC z migracji `00158`.
