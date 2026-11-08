# Zmiana marki FaktFlow → FaktWay — plan na naszej infrastrukturze

Źródło: runbook z ChatGPT (17.10.2026), przełożony na to, co faktycznie mamy
(Coolify na `ops-1`, aplikacja 1 + worker 2 na `app-1`, Supabase i MinIO jako
serwisy Coolify, Cloudflare, Resend, Stripe, Google OAuth). Adresy IP i sekrety
są w `.agents/infra.env`, nie tutaj — repozytorium jest publiczne.

**Zasada:** obie domeny działają równolegle aż do testu odbiorczego. Nic ze
starej domeny nie kasujemy. Baza, buckety, klucze KSeF, identyfikatory Stripe
i klucze idempotencji zostają bez zmian.

## 1. Stan na 17.10.2026 (sprawdzone z internetu)

Sprawdzenie w każdej chwili: `./scripts/ops/faktway-sprawdz.sh`.

| Element | Stan |
|---|---|
| Domena `faktway.pl` | kupiona 17.10.2026 (Hostido), odnowienie 17.10.2027, serwery nazw Cloudflare (to samo konto co `faktflow.pl`) |
| DNS `faktway.pl`, `www`, `db`, `s3` | rekordy A gotowe, celują w te same serwery co odpowiedniki `faktflow.pl` |
| TLS dla tych hostów | wszystkie cztery (`faktway.pl`, `www`, `db`, `s3`) — certyfikaty Let's Encrypt od 17.10 (etap B) |
| Poczta `faktway.pl` | MX Cloudflare Email Routing, jeden SPF (Cloudflare + Resend), DKIM `resend._domainkey`, MX zwrotów `send.faktway.pl`, DMARC `p=none` z raportami na `dmarc@faktway.pl` — gotowe |
| Subdomeny `app.faktway.pl`, `hello.faktway.pl` | bez DKIM — i niepotrzebne: produkcja wysyła z apeksu (niżej) |
| Śmieć w DNS | na obu domenach rekord TXT o treści `"resend._domainkey"` na apeksie — pomyłka przy wklejaniu, do usunięcia |
| Wyszukiwarka „FaktWay” | brak firmy/produktu o tej nazwie w wynikach; baz znaków (UPRP, EUIPO) nie sprawdzałem |

Z inwentarza Coolify (17.10.2026 17:46, `./scripts/ops/faktway-inwentarz.sh`):

| Gdzie | Dziś |
|---|---|
| Aplikacja 1 — domeny | `https://faktflow.pl,https://www.faktflow.pl` |
| Aplikacja 1 i 2 — działający commit | `face09c5` (wdrożony 10.10); **`main` ma 32 niewdrożone commity** |
| Aplikacje 1 i 2 — zmienne z „faktflow” | `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `R2_ENDPOINT`, `RESEND_FROM_TRANSACTIONAL=powiadomienia@faktflow.pl`, `RESEND_FROM_MARKETING=kontakt@faktflow.pl`, `VAPID_SUBJECT=kontakt@faktflow.pl`, `SENTRY_ORG` (slug Sentry — zostaje) |
| Serwis Supabase — Kong | domena `https://db.faktflow.pl:8000` (zmienne `SERVICE_FQDN_SUPABASEKONG*` generuje Coolify) |
| Serwis Supabase — GoTrue | `GOTRUE_SITE_URL=https://faktflow.pl`, `API_EXTERNAL_URL=https://db.faktflow.pl`, `ADDITIONAL_REDIRECT_URLS=https://faktflow.pl/auth/callback,https://faktflow.pl/**`, `SMTP_SENDER_NAME=FaktFlow`, `SMTP_ADMIN_EMAIL=powiadomienia@faktflow.pl` |
| Serwis MinIO (na `ops-1`) | domena `https://s3.faktflow.pl:9000` |
| Kopie bazy w Coolify | nie wiadomo — skrypt zgubił te wiersze (poprawione; uruchom inwentarz jeszcze raz) |
| Logowanie Google | **wyłączone w GoTrue** (`/auth/v1/settings` → `google: false`) — kroki 9, 19 (adres Google) i 23 dotyczą tylko sytuacji, gdy je włączysz |

## 2. Co robi PR z kodem (gałąź `claude/faktway-rebrand`)

- Nazwa w UI, mailach, pomocy, PDF, metadanych, PWA: FaktFlow → FaktWay.
- `lib/site.ts`: domyślnie `https://faktway.pl` i `pomoc@faktway.pl`
  (produkcja i tak bierze adres z `NEXT_PUBLIC_APP_URL`).
- Artykuły pomocy z nazwą w slugu: nowe slugi + 308 ze starych
  (`next.config.ts`).
- `lib/legacy-host-redirect.ts` + `proxy.ts`: przekierowanie 308 ze
  `faktflow.pl`/`www.faktflow.pl` na nową domenę z tą samą ścieżką —
  **wyłączone**, włącza je `LEGACY_HOST_REDIRECT=1`. Nie przekierowuje POST,
  `/auth/*`, `/reset-password`, `/api/*`, `/sw.js`, `/manifest.webmanifest`,
  `/ingest`, `/monitoring`.
- `ops/poczta/worker.mjs`: Email Worker obsługuje obie domeny.
- Zostaje świadomie: klucze idempotencji Stripe (`faktflow-checkout-v2:`,
  `faktflow-customer-v1:`), nazwy zmiennych `FAKTFLOW_*`, kod powodu
  `faktflow-original`, nagłówek `x-faktflow-no-org`, cache SW
  `faktflow-public-static-v1`, slug organizacji Sentry, pliki znaczka
  `/brand/faktflow-*.png` (to sam znaczek bez napisu).
- **Zostaje do osobnej migracji:** nazwa pozycji i uwagi na fakturze VAT za
  abonament (`FaktFlow — subskrypcja …`, `lib/billing/self-invoice.ts`).
  Funkcja `create_billing_vat_invoice` (00110) porównuje te napisy 1:1 —
  zmiana samego kodu zablokowałaby wystawienie faktury płacącemu klientowi.
  Najpierw migracja akceptująca oba warianty, potem zmiana napisów.
- **Zostaje do osobnej migracji:** komunikaty, które zwraca baza przy decyzji
  o duplikacie KSeF (`RAISE EXCEPTION` z 00148, lustro
  `DUPLICATE_DECISION_SQL_TEXTS` w `lib/ksef/duplicate-decision.ts`). Mają
  „FaktFlow” i `pomoc@faktflow.pl` — dlatego stara skrzynka musi odbierać
  pocztę, a test `jeden-adres-kontaktowy` dopuszcza starą domenę tylko w tym
  pliku. Naprawa: `CREATE OR REPLACE` z nowym numerem z rejestru + lustro
  i migawka w tym samym PR — **szkic #280 (migracja 00151, stos na tym PR)**;
  wgrać w dniu przełączenia, przed wdrożeniem tego PR.

PR jest szkicem. **Scalamy go dopiero w dniu przełączenia (etap E)**, bo
zmienia adres pomocy w całej aplikacji na `pomoc@faktway.pl`.

## 3. Zadania — kto i w jakiej kolejności

Legenda: **[B]** tylko Bartosz (panel, konto, decyzja prawna),
**[C]** sesja Claude z dostępem do produkcji, **[B/C]** albo-albo.

### Etap 0 — przygotowanie (nic nie przełącza)

1. **[B]** Sprawdź nazwę w bazach znaków towarowych: UPRP
   (<https://ewyszukiwarka.pue.uprp.gov.pl>) i EUIPO TMview
   (<https://www.tmdn.org/tmview>), klasy 9, 35, 36, 42. Przy wątpliwościach —
   rzecznik patentowy. Bez tego dalsze kroki to ryzyko drugiej zmiany nazwy.
2. **[B]** Hostido: włącz 2FA na koncie i automatyczne odnawianie `faktway.pl`.
   `faktflow.pl` zostaje opłacona co najmniej 24 miesiące.
3. **[B]** Cloudflare → `faktflow.pl` → DNS → Export (plik
   `faktflow-dns-przed-migracja-2026-10-17.txt`), to samo dla `faktway.pl`.
4. **[B]** Uruchom inwentarz (tylko odczyt + lokalna kopia zmiennych):
   `./scripts/ops/faktway-inwentarz.sh` → raport bez sekretów wklej Claude'owi.
   Kopia zmiennych z sekretami ląduje w `.agents/backup/faktway-<data>/`.
5. **[B]** Zapisz w menedżerze haseł obecne adresy webhooków Stripe i Resend
   oraz listę zdarzeń webhooka Stripe (Developers → Webhooks).

### Etap B — nowe hosty równolegle do starych

**Stan 17.10.2026 (sesja Claude, za zgodą Bartosza):**
- krok 7 zrobiony: `/data/coolify/proxy/dynamic/faktway-db.yaml` (db-1) i
  `faktway-s3.yaml` (ops-1); certyfikaty wystawione, `db.faktway.pl` → Kong
  (401 bez klucza, `/auth/v1/settings` z kluczem anon → 200),
  `s3.faktway.pl/minio/health/live` → 200; żaden kontener nie restartował;
- krok 8 zrobiony: lista w Coolify i w `.env` serwisu (kopia
  `.env.przed-faktway-20261017-161138`), odtworzony tylko `supabase-auth`
  (healthy), reszta stosu bez restartu;
- krok 6 zrobiony: domeny aplikacji 1 + odświeżone `custom_labels`
  (wdrożenie #148 wzięło stare zapisane etykiety, bez faktway — Coolify nie
  generuje ich z domen, gdy `custom_labels` są zapisane), wdrożenie #149
  commitu `face09c5` z gotowego obrazu, bez przerwy w działaniu;
- bramka B automatycznie: `./scripts/ops/faktway-sprawdz.sh` → „Wszystko OK”,
  `https://faktway.pl/login` renderuje się, konsola bez błędów.
- **zostaje [B]:** logowanie hasłem na `https://faktway.pl/login` (konto
  testowe), podgląd PDF faktury, Turnstile (krok 10) — formularz pokazuje
  widżet, ale bez dodanego hosta weryfikacja może odrzucić token.

6. **[B/C]** Coolify → aplikacja 1 → Domains: dopisz
   `,https://faktway.pl,https://www.faktway.pl` (stare zostają) → Save.
   **Nie klikaj „Redeploy”** — zbudowałby `main` z 32 niewdrożonymi
   commitami. Zamiast tego wdróż ponownie działający commit `face09c5`
   (zakładka Rollback → obraz `face09c5…`, albo tinker
   `queue_application_deployment(..., commit: '<pełny sha>')`). Etykiety
   Traefika powstają przy wdrożeniu, więc sam zapis domen nic nie zmienia.
7. **[B/C]** `db.faktway.pl` i `s3.faktway.pl` — bez restartu czegokolwiek:
   plik dynamicznej konfiguracji Traefika (Coolify → Servers → `db-1` /
   `ops-1` → Proxy → Dynamic Configurations, czyli katalog
   `/data/coolify/proxy/dynamic/`) z routerem `Host(...)` na ten sam
   kontener (`supabase-kong-<uuid>:8000`, `minio-<uuid>:9000`) i
   `certResolver: letsencrypt`. Usunięcie pliku cofa zmianę.
   **Nie** dopisuj domeny w ustawieniach serwisu Supabase: zapis i restart
   z panelu odtwarzają cały stos razem z Postgresem.
8. **[B/C]** Serwis Supabase → `ADDITIONAL_REDIRECT_URLS` dopisz
   `,https://faktway.pl/auth/callback,https://faktway.pl/**,https://www.faktway.pl/auth/callback,https://www.faktway.pl/**`
   (bez tego Google, rejestracja i reset hasła z `faktway.pl` wracają na
   `GOTRUE_SITE_URL`). Zastosowanie: przez SSH tylko kontener auth
   (`docker compose -p <projekt> up -d --no-deps supabase-auth` po zmianie
   `.env` serwisu — kilka sekund bez logowania). Restart z panelu odtwarza
   cały stos (około minuty przerwy). `GOTRUE_SITE_URL`, `API_EXTERNAL_URL`
   i adres Google na razie **bez zmian** — logowanie Google z `faktway.pl`
   idzie przez `db.faktflow.pl`, który Google już zna.
9. **[B]** Google Cloud Console → APIs & Services → Credentials → klient
   OAuth → Authorized redirect URIs: **dodaj**
   `https://db.faktway.pl/auth/v1/callback` (stary zostaje). OAuth consent
   screen → Authorized domains: dodaj `faktway.pl`; nazwa aplikacji, strona
   główna i polityka prywatności — na razie bez zmian (zmienisz w dniu E).
10. **[B]** Cloudflare → Turnstile → widget → Hostnames: dodaj `faktway.pl`
    i `www.faktway.pl` (stare zostają).
11. **Bramka B:** `./scripts/ops/faktway-sprawdz.sh` — wszystkie linie TLS
    i „Usługi pod nowymi adresami” na OK. Ręcznie: logowanie hasłem na
    `https://faktway.pl/login`, podgląd PDF faktury (plik z S3).

### Etap C — poczta

12. **Nadawcy — rozstrzygnięte przez inwentarz.** Produkcja wysyła z apeksu
    (`powiadomienia@faktflow.pl`, `kontakt@faktflow.pl`), więc nowe adresy to
    `FaktWay <powiadomienia@faktway.pl>` i `FaktWay <kontakt@faktway.pl>`
    (apeks `faktway.pl` ma już DKIM). Subdomeny z planu ChatGPT nie są
    potrzebne. Kod (domyślny nadawca, `.env.example`) jest już na tych
    adresach.
13. **[B]** Resend → Domains: sprawdź, że `faktway.pl` ma status Verified
    (rekordy w DNS już są).
14. **[B]** Cloudflare → `faktway.pl` → Email → Email Routing: włącz
    catch-all (albo regułę `pomoc@`, `dmarc@`) → akcja „Send to Worker” →
    ten sam Email Worker co dla `faktflow.pl`. Wcześniej wklej do workera
    nowy kod z `ops/poczta/worker.mjs` (obsługuje obie domeny).
15. **[B]** Test: mail z prywatnej skrzynki na `pomoc@faktway.pl` **i**
    `pomoc@faktflow.pl` — oba mają dać powiadomienie na Telegramie.
16. **[B]** Usuń zbędne rekordy TXT `"resend._domainkey"` z apeksu obu domen
    (prawdziwy DKIM jest pod nazwą `resend._domainkey`, ten zostaje).

### Etap E — dzień przełączenia (spokojna pora, 2-3 h zapasu)

17. **[B]** „scal PR i wdróż” — dopiero po bramkach B i C.
18. **[C]** Coolify, aplikacje 1 **i** 2 (zmienne `is_preview = false`):
    - `NEXT_PUBLIC_APP_URL=https://faktway.pl`
    - `NEXT_PUBLIC_SUPABASE_URL=https://db.faktway.pl`
    - `R2_ENDPOINT=https://s3.faktway.pl`
    - `RESEND_FROM_TRANSACTIONAL=FaktWay <powiadomienia@faktway.pl>`
    - `RESEND_FROM_MARKETING=FaktWay <kontakt@faktway.pl>`
    - `VAPID_SUBJECT=mailto:pomoc@faktway.pl`
    - każda inna zmienna z listy „wartość zawiera faktflow” z inwentarza
    `NEXT_PUBLIC_*` są wbudowywane w build — sam zapis nie wystarczy,
    potrzebne wdrożenie.
19. **[C]** Serwis Supabase: `GOTRUE_SITE_URL=https://faktway.pl`,
    `API_EXTERNAL_URL=https://db.faktway.pl`, adres powrotu Google na
    `https://db.faktway.pl/auth/v1/callback` (najpierw krok 9!),
    `SMTP_SENDER_NAME=FaktWay`, `SMTP_ADMIN_EMAIL=powiadomienia@faktway.pl`;
    `ADDITIONAL_REDIRECT_URLS` zostawia też stare adresy. Odtworzenie tylko
    kontenera auth (GoTrue).
20. **[C]** Wdrożenie: worker (id=2), potem aplikacja (id=1), po kolei.
21. **[B]** Stripe → Developers → Webhooks → istniejący endpoint → Update:
    URL `https://faktway.pl/api/stripe/webhook` (ta sama lista zdarzeń, ten
    sam sekret — przy edycji URL Stripe go nie zmienia). Nie twórz drugiego
    endpointu. Test: „Send test event” → 200 w logach aplikacji.
    Przy okazji: Settings → Public details (nazwa, strona, statement
    descriptor) i nazwy produktów → FaktWay.
22. **[B]** Resend → Webhooks → istniejący endpoint: host na `faktway.pl`,
    ścieżka `/api/email/resend-webhook` bez zmian, sekret bez zmian.
23. **[B]** Google OAuth consent screen: nazwa „FaktWay”, strona główna
    i polityka prywatności na `faktway.pl`.
24. **[C]** Test odbiorczy (sekcja 4). Dopiero po nim: `LEGACY_HOST_REDIRECT=1`
    w aplikacji 1 i restart → stara domena przekierowuje 308.
25. **[B]** Monitory zewnętrzne i bramka Telegram: `PUBLIC_HEALTH_URL` na
    `https://faktway.pl/api/health`.
26. **[B]** Komunikat do klientów: nowa nazwa i adres, ta sama firma i te same
    dane, trzeba zalogować się ponownie, powiadomienia push i instalację PWA
    trzeba włączyć jeszcze raz (sesje i zgody są przypisane do domeny).
26a. **[C]** Logowanie biometrią. RP ID biometrii pochodzi z `NEXT_PUBLIC_APP_URL`
    (`lib/auth/passkey/config.ts`), a klucz jest przypisany do RP ID na stałe, więc po
    zmianie domeny wszystkie dotychczasowe klucze przestają działać. W tym samym kroku,
    dopiero po teście odbiorczym (24): skasuj wiersze `user_passkeys` i powiadom klientów,
    że dodają klucz ponownie.
    - Najpierw policz: `source .agents/infra.env && ssh -i $K root@$DB "docker exec $PGC psql -U postgres -d postgres -c 'SELECT count(*) FROM public.user_passkeys;'"`.
      Zero albo brak tabeli (migracja 00159 jeszcze niewgrana): krok jest pusty, przejdź do 27.
    - Kasowanie, za zgodą Bartosza (`DELETE FROM`): to samo polecenie z
      `DELETE FROM public.user_passkeys;`, potem ponownie `count(*)` ma dać 0. Bez tego
      lista urządzeń w Ustawieniach pokazuje klucze, które już nie zalogują.
    - **[B]** Dopisz do komunikatu z kroku 26: logowanie odciskiem palca lub twarzą trzeba
      dodać ponownie (Ustawienia, zakładka Bezpieczeństwo, „Dodaj urządzenie”); hasło i kod
      z aplikacji działają bez zmian.

    Skasowanych kluczy nie przywrócimy: po powrocie na starą domenę (sekcja 5) klienci
    dodają je jeszcze raz, dlatego nie robimy tego przed testem odbiorczym.

### Po wdrożeniu

27. **[C]** Dwie migracje, każda w osobnym PR według protokołu napraw:
    (a) `create_billing_vat_invoice` akceptuje `FaktWay — subskrypcja …` obok
    `FaktFlow — …` (także `notes` przy idempotencji), potem zmiana napisów
    w `lib/billing/self-invoice.ts`; (b) teksty `RAISE` z 00148 na FaktWay
    i `pomoc@faktway.pl` + lustro w `lib/ksef/duplicate-decision.ts` —
    #280, migracja 00151 (wgrać w dniu przełączenia razem z wdrożeniem).
28. **[C]** `AGENTS.md`, runbooki i `scripts/ops/kontrola-faktur-ksef.sh` —
    adresy weryfikacyjne na `faktway.pl` (dopiero po przełączeniu, bo dziś
    opisują działającą produkcję).
29. **[B]** Po 30/90 dniach: ruch na starej domenie, błędy 404 w Sentry.
    `faktflow.pl` trzymamy minimum 24 miesiące (przejęcie wygasłej domeny =
    podszywanie się pod markę).

## 4. Test odbiorczy (dzień E)

- [ ] `https://faktway.pl` i `www` — 200, poprawny certyfikat, brak pętli
- [ ] logowanie hasłem, rejestracja, **Google**, reset hasła (konto testowe)
- [ ] linki w mailach prowadzą na `faktway.pl`
- [ ] podgląd i pobranie PDF/XML (S3), wgranie nowego pliku
- [ ] KSeF TEST: wysyłka faktury bez regresji
- [ ] Stripe: test event dostarczony i przetworzony, brak podwójnej faktury
- [ ] mail transakcyjny i marketingowy: nadawca, `Reply-To: pomoc@faktway.pl`,
      rezygnacja z subskrypcji działa
- [ ] `pomoc@faktway.pl` i `pomoc@faktflow.pl` odbierają
- [ ] PWA: nazwa FaktWay, instalacja, nowa subskrypcja push
- [ ] Sentry i PostHog dostają zdarzenia z nowej domeny
- [ ] worker: w logu „27/27 cronów”, brak nowych błędów
- [ ] `./scripts/ops/faktway-sprawdz.sh` — wszystko OK

## 5. Powrót (rollback)

Kolejność odwrotna, tylko to, co zawiodło: `LEGACY_HOST_REDIRECT` puste →
zmienne aplikacji i Supabase z kopii `.agents/backup/faktway-<data>/` →
webhooki Stripe/Resend z powrotem na `faktflow.pl` → wdrożenie poprzedniego
commita. Danych w bazie, bucketów, kluczy KSeF i identyfikatorów Stripe nie
ruszamy.
