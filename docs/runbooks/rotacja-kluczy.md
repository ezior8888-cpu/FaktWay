# Rotacja kluczy produkcyjnych

> Powód pierwszej rotacji: do 14.09.2026 klucze produkcyjne leżały w projekcie
> Vercel `ksef-saas` (42 zmienne wspólne dla Preview i Production), skasowanym
> tego dnia bez rotacji. Kontekst: [`ODPOWIEDZ-BARTEK-2026-09-14.md`](../security/ODPOWIEDZ-BARTEK-2026-09-14.md).
> Ten runbook zastępuje nieaktualny [`key-rotation.md`](key-rotation.md) (Vercel, Inngest).
> Pułapki panelu: [`coolify-pulapki.md`](coolify-pulapki.md).

## Najważniejsze

1. **Kolejność:** 0 przygotowanie → 1 klucze bez przerwy (1a–1f) → 2 sekret
   wypisu → 3 `JWT_SECRET` Supabase (wylogowanie, przerwa w nocy) → 4 klucz
   szyfrowania danych KSeF (bez przerwy, przeszyfrowanie). Krok 3 przed 4:
   stary klucz service_role dawał odczyt zaszyfrowanych danych KSeF.
2. **Po każdym kroku jedna linia:**

   ```bash
   ./scripts/ops/rotacja-kluczy.sh
   ```

   Pokazuje odciski sekretów (12 znaków SHA-256 liczonych na serwerze) w obu
   aplikacjach i w Supabase, mówi, który się ZMIENIŁ od poprzedniej kontroli,
   wykrywa rozjazd (aplikacja ≠ worker, aplikacja ≠ Kong) i sprawdza
   działanie: health, logowanie, klucz service_role, mail przez API Resend
   i przez SMTP GoTrue, zapis i odczyt MinIO, Turnstile, Slack, Google,
   odszyfrowanie danych KSeF. Kod 0 = idziesz dalej. Kod 1 = cofasz krok.
3. **Nowe wartości:** z panelu dostawcy albo z generatora, który pisze do
   pliku (`chmod 600`, poza gitem), nie na ekran:

   ```bash
   ./scripts/ops/rotacja-generuj.sh jwt
   ```

   ```bash
   ./scripts/ops/rotacja-generuj.sh hex KSEF_CREDENTIALS_ENCRYPTION_KEY
   ```

   Wartości nie wklejaj do czatu ani do generatorów w przeglądarce. Klika
   Bartosz, agent tylko czyta wynik kontroli.
4. **Stary klucz kasujesz u dostawcy dopiero po zielonej kontroli.** Do tego
   czasu cofnięcie to wpisanie starej wartości i restart.

## Mapa: co, gdzie, czy przebudowa

| Klucz | Panel dostawcy | Coolify | Przebudowa | Przerwa |
|---|---|---|---|---|
| `RESEND_API_KEY` | Resend → API Keys | `id=1`, `id=2`, usługa Supabase (`GOTRUE_SMTP_PASS`) | nie, Restart | brak (dwa klucze naraz) |
| `RESEND_WEBHOOK_SECRET` | Resend → Webhooks | `id=1` | nie | minuty opóźnienia zdarzeń, Resend ponawia |
| `TURNSTILE_SECRET_KEY` | Cloudflare → Turnstile | `id=1`, usługa Supabase (`GOTRUE_SECURITY_CAPTCHA_SECRET`, gdy captcha w GoTrue) | nie | brak (stary ważny 2 h) |
| `SLACK_WEBHOOK_*` | api.slack.com → aplikacja → Incoming Webhooks | `id=1`, `id=2` | nie | brak (dwa adresy naraz) |
| `GOOGLE_CLIENT_SECRET` | Google Cloud → Credentials → klient OAuth | tylko usługa Supabase (`GOTRUE_EXTERNAL_GOOGLE_SECRET`) | nie | brak (dwa sekrety naraz) |
| `R2_*` (MinIO), `AWS_*` | konsola MinIO na `ops-1`, Cloudflare R2, AWS IAM | `id=1`, `id=2` | nie | brak; restart MinIO przy haśle root: sekundy |
| `EMAIL_UNSUBSCRIBE_SECRET` | brak (generator) | `id=1`, `id=2` | nie | stare linki wypisu (zob. krok 2) |
| `JWT_SECRET` → `ANON_KEY`, `SERVICE_ROLE_KEY` | brak (generator) | usługa Supabase, `id=1`, `id=2`, zmienna repo w GitHub | **tak, aplikacja** (anon jest zmienną builda) | tak: wylogowanie, kilka do kilkunastu minut |
| `KSEF_CREDENTIALS_ENCRYPTION_KEY` | brak (generator) | `id=1`, `id=2` (`_PREVIOUS` na czas rotacji) | nie | brak |
| `WEBHOOK_SECRETS_ENCRYPTION_KEY` (webhooki API, 00187) | brak (generator) | `id=1`, `id=2` (`_PREVIOUS`: odczyt sekretów zaszyfrowanych starym kluczem) | nie | brak, dopóki `_PREVIOUS` zostaje; skryptu przeszyfrowania jeszcze nie ma, więc bez niego klient musi dodać webhook od nowa |

## 0. Przygotowanie

1. Tunel do panelu: `ssh -i $K -N -L 8000:localhost:8000 root@$OPS`, potem
   `http://localhost:8000` (`coolify-pulapki.md`).
2. Punkt powrotu: `./scripts/ops/faktway-inwentarz.sh` zapisuje kopię
   wszystkich zmiennych Coolify z sekretami w `.agents/backup/faktway-<data>/`
   (`chmod 600`, poza gitem). Stąd bierzesz stare wartości przy cofaniu.
3. Kontrola wyjściowa: `./scripts/ops/rotacja-kluczy.sh` musi dać „Wszystko
   OK”. Zapisuje odciski; kolumna zmian porównuje zawsze z **poprzednią**
   kontrolą, więc „ZMIENIONY” widać w pierwszej kontroli po kroku. Przy
   powtórce tej samej kontroli porównuj odcisk z odciskiem z generatora albo
   z zapisanym przed krokiem.
   Zapisz z niej, czy `SMTP GoTrue używa tego samego klucza Resend` i czy
   `GOOGLE_CLIENT_SECRET`, `AWS_*`, `SLACK_WEBHOOK_*` w ogóle są ustawione.
4. Zasady w Coolify, ważne w każdym kroku:
   - zmieniasz zmienną produkcyjną (`is_preview = false`), nie jej bliźniaka
     z sekcji podglądów;
   - **Restart**, nie Redeploy: Restart odtwarza kontener z tym samym obrazem
     i nowymi zmiennymi w kilka sekund. Redeploy buduje `HEAD` gałęzi
     `main`, czyli wdrożyłby niewdrożony kod;
   - kolejność restartów zawsze: worker (`id=2`), potem aplikacja (`id=1`);
   - **usługa Supabase na `db-1`**: zmiany dotyczące samego GoTrue (SMTP,
     Google, captcha) wprowadzasz w Coolify (żeby przetrwały) **i** w pliku
     `.env` usługi na `db-1`, a potem odtwarzasz tylko kontener logowania.
     Nazwę projektu compose wypisuje kontrola („projekt compose: …”); katalog
     usługi to zwykle `/data/coolify/services/<projekt>`. To praca w zwykłym
     Terminalu, nie przyciskiem „Run” (sesja SSH i edytor są interaktywne):
     `source .agents/infra.env`, potem `ssh -i "$K" root@"$DB"`, a na `db-1`
     w katalogu usługi: kopia `cp .env .env.przed-rotacja-<data>`, edycja
     `.env` (`nano .env`) i odtworzenie samego kontenera logowania
     `docker compose -p <projekt> up -d --no-deps supabase-auth`.
     Kilka sekund bez logowania. Tak zrobiono 17.10.2026 (`docs/rebrand/FAKTWAY.md`,
     krok 8). Restart całej usługi z panelu też działa, ale zatrzymuje
     Postgresa i API na 1–2 minuty. Kopie `.env.przed-rotacja-*` zawierają
     stare sekrety: usuń je po zakończeniu rotacji.

## 1. Bez przerwy

### 1a. `RESEND_API_KEY` (aplikacja, worker, SMTP GoTrue)

1. Resend → **API Keys** → Create API Key: `faktway-app-2026-11`, uprawnienie
   *Sending access*. Jeśli kontrola mówi, że SMTP GoTrue używa tego samego
   klucza, utwórz drugi, osobny: `faktway-gotrue-smtp-2026-11`. Osobne klucze
   rotuje się potem niezależnie.
2. Coolify `id=2` i `id=1` → `RESEND_API_KEY` = nowy klucz aplikacji.
   Restart workera, potem aplikacji.
3. Usługa Supabase → zmienna hasła SMTP (w kontenerze `GOTRUE_SMTP_PASS`,
   w szablonie Coolify zwykle `SMTP_PASS`) = klucz SMTP; ta sama zmiana
   w `.env` na `db-1` i odtworzenie `supabase-auth` (punkt 0.4).
4. Kontrola: `RESEND_API_KEY` ZMIENIONY w obu kolumnach, `[app] mail`,
   `[worker] mail` i `[GoTrue] smtp` OK. Na własną skrzynkę:
   `ROTACJA_MAIL_DO=adres ./scripts/ops/rotacja-kluczy.sh`.
5. Sprzątanie: Resend → API Keys → stary klucz → kolumna *Last used* przestaje
   rosnąć → **Delete**. Przy okazji przejrzyj Resend → **Emails** od 14.09.2026
   pod kątem wysyłek, których nie rozpoznajesz.

Cofnięcie przed usunięciem starego klucza: stara wartość z kopii, Restart.

### 1b. `RESEND_WEBHOOK_SECRET` (aplikacja)

Podpis zdarzeń z Resend (odbicia, skargi) na `/api/email/resend-webhook`.

1. Resend → **Webhooks** → endpoint aplikacji. Jeśli jest opcja rotacji
   sekretu podpisu, użyj jej. Jeśli nie: **Add endpoint** na ten sam adres
   z tymi samymi zdarzeniami i skopiuj jego *Signing secret* (`whsec_…`).
2. Coolify `id=1` → `RESEND_WEBHOOK_SECRET` = nowy sekret → Restart aplikacji.
3. Usuń stary endpoint w Resend.
4. Kontrola: `RESEND_WEBHOOK_SECRET` ZMIENIONY. Potem Resend → Webhooks →
   nowy endpoint → ostatnie dostawy mają 2xx (pierwsze pojawią się przy
   najbliższym odbiciu; „Send test event”, jeśli panel go ma).

Między krokami 1 i 3 część zdarzeń dostaje 400 (zły podpis); Resend ponawia
je przez kilka godzin, więc nic nie ginie. Duplikat z dwóch endpointów nie
zapisze się drugi raz: odbicia i skargi mają unikalny identyfikator
zdarzenia (`email_bounces.resend_event_id`).

### 1c. `TURNSTILE_SECRET_KEY` (aplikacja, opcjonalnie GoTrue)

1. Cloudflare → **Turnstile** → widżet FaktWay (site key zostaje ten sam) →
   **Rotate secret key**, bez natychmiastowego unieważnienia: stary sekret
   działa jeszcze 2 godziny. Kroki 2–3 zrób w tym oknie.
2. Coolify `id=1` → `TURNSTILE_SECRET_KEY` → Restart aplikacji. Worker go
   nie używa.
3. Tylko gdy captcha jest w GoTrue (kontrola: `gotrue.GOTRUE_SECURITY_CAPTCHA_SECRET`
   ma odcisk): usługa Supabase → `GOTRUE_SECURITY_CAPTCHA_SECRET` = ta sama
   wartość, `.env` na `db-1`, odtworzenie `supabase-auth`. Potem
   `./scripts/ops/kontrola-captcha-gotrue.sh`.
4. Kontrola: `[app] turnstile` OK (Cloudflare przyjmuje sekret).

Cofnięcie: w ciągu 2 godzin stara wartość jeszcze działa. Później tylko
kolejna rotacja.

### 1d. `SLACK_WEBHOOK_URGENT`, `_BUGS`, `_METRICS`

Alarmy idą dziś głównie Telegramem; kontrola pokazuje, czy zmienne Slacka są
w ogóle ustawione. Stare adresy unieważniasz w obu przypadkach.

1. api.slack.com/apps → aplikacja alarmów → **Incoming Webhooks** → *Add New
   Webhook to Workspace* dla każdego kanału. Stary adres dalej działa.
2. Jeśli zmienne są w Coolify: nowe adresy w `id=2` i `id=1`, Restart
   workera, potem aplikacji. Kontrola: `slack-urgent` (itd.) OK; sonda wysyła
   pusty JSON, więc nic nie pojawia się na kanale.
3. W tej samej liście webhooków usuń stare adresy (Remove).

### 1e. `GOOGLE_CLIENT_SECRET` (tylko GoTrue)

Kod aplikacji tego sekretu nie czyta: logowanie Google obsługuje GoTrue na
`db-1`. Jeśli kontrola pokazuje `GOOGLE_CLIENT_SECRET` w `id=1`/`id=2`, usuń
tam zmienną po tym kroku.

1. Google Cloud Console → **APIs & Services → Credentials** → klient OAuth
   z adresem zwrotnym `https://db.faktflow.pl/auth/v1/callback` → **Add
   secret**. Google trzyma dwa sekrety naraz.
2. Usługa Supabase → `GOTRUE_EXTERNAL_GOOGLE_SECRET` = nowy sekret, `.env`
   na `db-1`, odtworzenie `supabase-auth`.
3. Kontrola: `gotrue.GOTRUE_EXTERNAL_GOOGLE_SECRET` ZMIENIONY, „Google: GoTrue
   przekierowuje do Google”. **Ręcznie:** wyloguj się i zaloguj przez Google.
   Sekret sprawdza dopiero wymiana kodu po powrocie z Google.
4. Stary sekret: **Disable**, po dniu bez problemów **Delete**.

Cofnięcie: *Enable* starego sekretu i stara wartość w GoTrue.

### 1f. Pliki: MinIO (`R2_*`), stary Cloudflare R2, `AWS_*`

**Ustal najpierw, czym jest obecny `R2_ACCESS_KEY_ID`.** Migracja z sierpnia
(`docs/migration/PRZEPROWADZKA-HETZNER.md`, etap 5) kazała wpisać klucze
„z MinIO”, czyli najpewniej konto root usługi (w Coolify: `SERVICE_USER_MINIO`
/ `SERVICE_PASSWORD_MINIO`). Porównaj w panelu: usługa MinIO → zmienne
z `R2_ACCESS_KEY_ID` aplikacji.

1. Konsola MinIO (domena konsoli albo tunel do `ops-1`) → zaloguj się jako
   root → **Identity → Users** → *Create user* `faktway-app` z polityką
   ograniczoną do bucketów aplikacji (wstaw nazwy z `R2_BUCKET_NAME`
   i `R2_BACKUPS_BUCKET`):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"],
         "Resource": ["arn:aws:s3:::<R2_BUCKET_NAME>", "arn:aws:s3:::<R2_BACKUPS_BUCKET>"]
       },
       {
         "Effect": "Allow",
         "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
         "Resource": ["arn:aws:s3:::<R2_BUCKET_NAME>/*", "arn:aws:s3:::<R2_BACKUPS_BUCKET>/*"]
       }
     ]
   }
   ```

   Potem w użytkowniku **Access Keys** → *Create access key* i skopiuj parę.
2. Coolify `id=2` i `id=1` → `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` →
   Restart workera, potem aplikacji.
3. Kontrola: oba ZMIENIONE, `[app] minio` i `[worker] minio` OK (zapis,
   odczyt, usunięcie obiektu próbnego), `minio-kopie` OK, jeśli kopie mają
   osobny bucket. Następnej nocy sprawdź, czy kopia JSON (warstwa C
   z `backup-restore.md`) powstała.
4. Stary klucz:
   - jeśli to był osobny klucz dostępu: usuń go w konsoli;
   - jeśli to było konto root: Coolify → usługa MinIO → zmień
     `SERVICE_PASSWORD_MINIO` (nowe hasło root, menedżer haseł) → Restart
     usługi MinIO (kilka sekund bez plików, wieczorem) → od razu kontrola:
     `[app] minio` musi zostać OK na nowym kluczu użytkownika. Jeśli pokaże
     `InvalidAccessKeyId`, przywróć stare hasło root i Restart.
     Zaktualizuj też inne miejsca z hasłem root: magazyn S3 w ustawieniach
     Coolify (jeśli kopie Coolify idą do MinIO) i `rclone config` na Macu
     z czasu migracji.
5. **Cloudflare R2** (pliki sprzed migracji, zapas na 30 dni od sierpnia):
   Cloudflare → R2 → **Manage R2 API Tokens** → usuń wszystkie tokeny. Bucket
   usuń, gdy potwierdzisz, że nie jest potrzebny.
6. **`AWS_*`** (archiwum Glacier, odłożone do ok. 2028): AWS → IAM → użytkownik
   z tym kluczem → *Security credentials* → klucz → **Deactivate** (odwracalne),
   sprawdź *Last used*, po tygodniu **Delete**. Jeśli `AWS_*` są w Coolify,
   usuń je. Nowy klucz załóż dopiero, gdy archiwum ruszy.

## 2. `EMAIL_UNSUBSCRIBE_SECRET`

**Co mówi kod.** `lib/email/unsubscribe-token.ts`: token wypisu to
`payload.HMAC-SHA256` jednym sekretem, ważny 90 dni. Podpisują go aplikacja
i worker (`lib/email/send.ts`, tylko maile `product_updates` i `marketing`),
sprawdza aplikacja (`app/api/email/unsubscribe/route.ts`). **Dziś nie da się
przyjmować starego i nowego sekretu naraz.** Po zmianie każdy link wypisu
z ostatnich 90 dni jest nieważny, a wypis jednym kliknięciem z Gmaila
i Outlooka (RFC 8058) dostaje cicho `200 skipped`: skrzynka pokazuje
„wypisano”, a my wysyłamy dalej. Dla maili marketingowych to problem
zgody, nie tylko wygody.

**Projekt na dwa sekrety (osobny PR z testem, jak klucz KSeF):**
`EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS`; podpis zawsze bieżącym, weryfikacja
bieżącym, a przy złym podpisie poprzednim. Test: token podpisany starym
sekretem przechodzi, gdy stary jest w `_PREVIOUS`, i nie przechodzi bez
niego. Brak `_PREVIOUS` = zachowanie jak dziś.

**Procedura po wdrożeniu tego PR:**

1. `./scripts/ops/rotacja-generuj.sh hex EMAIL_UNSUBSCRIBE_SECRET`.
2. Coolify `id=2` i `id=1`: `EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS` = obecna
   wartość, `EMAIL_UNSUBSCRIBE_SECRET` = nowa. Restart workera, potem
   aplikacji.
3. Kontrola: `EMAIL_UNSUBSCRIBE_SECRET` ZMIENIONY i taki sam w obu kolumnach.
4. Wpis w kalendarzu na dzień + 90: usuń `_PREVIOUS` z obu, Restart.

**Bez PR** (tylko jeśli tak zdecydujesz): Resend → Emails, nadawca
`RESEND_FROM_MARKETING` i maile z `List-Unsubscribe` z ostatnich 90 dni. Jeśli
takich nie było, stare linki nikogo nie dotyczą: punkty 1–3 bez `_PREVIOUS`.

Cofnięcie: stara wartość z kopii, Restart obu.

## 3. `JWT_SECRET` Supabase → `ANON_KEY`, `SERVICE_ROLE_KEY`

**Dlaczego:** `SUPABASE_SERVICE_ROLE_KEY` był w Vercelu, a to JWT ważny latami,
którego nie da się unieważnić inaczej niż zmianą `JWT_SECRET`. Klucz anon
z kontroli ma `iat` z 14.08.2026, czyli ten sam, który Vercel najpewniej miał.

**Skutki, które trzeba przyjąć:**
- tokeny dostępu podpisane starym sekretem przestają działać; zakładaj, że
  wszyscy zostaną wylogowani (konta z 2FA podadzą kod);
- znaczniki sesji z klucza biometrycznego (HKDF z `SUPABASE_SERVICE_ROLE_KEY`,
  `lib/auth/passkey/session-marker.ts`) też tracą ważność: zalogowani
  biometrią podadzą kod albo zalogują się ponownie;
- otwarte karty i PWA mają stary klucz anon w kodzie strony, więc do
  odświeżenia dostają 401;
- połączenie pg-boss (`DATABASE_URL`, hasło Postgresa) się nie zmienia.

**Przerwa** trwa od restartu Supabase do startu aplikacji z nowym kluczem
anon, który jest wkompilowany w build. Aplikacji nie da się wdrożyć
wcześniej: healthcheck nowego kontenera pyta bazę kluczem service_role, przy
starym sekrecie dostałby 503 i Coolify wycofałby wdrożenie.
- droga przez GitHub Actions (`wdrozenie-produkcji.md`, „Droga przez GitHub
  Actions”), gdy działa: obraz zbudowany wcześniej, przerwa kilka minut;
- stara droga (build na `app-1`): przerwa = build aplikacji, 12–18 minut.

Rób to w nocy, **zaraz po pełnym wydaniu**, gdy `main` = produkcja: wtedy
przebudowa aplikacji nie wnosi nowego kodu.

1. `./scripts/ops/rotacja-generuj.sh jwt` → plik z `JWT_SECRET`, `ANON_KEY`,
   `SERVICE_ROLE_KEY` i ich odciski.
2. **Przygotowanie bez restartu** (zapisz, nie restartuj):
   - GitHub → repo → Settings → Secrets and variables → Actions →
     **Variables** → `NEXT_PUBLIC_SUPABASE_ANON_KEY` = `ANON_KEY`
     (`.github/workflows/obrazy.yml` buduje z niej obraz);
   - Coolify `id=1`: `NEXT_PUBLIC_SUPABASE_ANON_KEY` (zmienna builda)
     i `SUPABASE_SERVICE_ROLE_KEY`; `id=2`: `SUPABASE_SERVICE_ROLE_KEY`
     (i `NEXT_PUBLIC_SUPABASE_ANON_KEY`, jeśli tam jest);
   - Coolify `id=1`: `SUPABASE_JWT_SECRET` = `JWT_SECRET`, jeśli jest
     ustawiona (publiczne API `/api/v1` podpisuje nim token roli
     `api_key_client`, 00181). Ze starym sekretem API odpowiada 503, nic
     więcej się nie psuje.
   Kroki 2–4 rób bez przerw: gdyby aplikacja w tym czasie sama się
   zrestartowała, wstanie z nowym kluczem do starej bazy.
3. **Usługa Supabase** (Coolify, `db-1`) → Environment Variables: sekret JWT
   (w szablonie Coolify zwykle `SERVICE_PASSWORD_JWT`), klucz anon
   (`SERVICE_SUPABASEANON_KEY`) i service (`SERVICE_SUPABASESERVICE_KEY`).
   Sprawdź nazwy w panelu, zanim zmienisz. → **Restart całej usługi** (Kong,
   GoTrue, PostgREST, Realtime, Storage czytają sekret przy starcie).
4. Worker `id=2`: Restart. Aplikacja `id=1`: wdrożenie z przebudową
   (Redeploy w panelu albo obraz z GitHub Actions).
5. Kontrola: `SUPABASE_SERVICE_ROLE_KEY` i `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   ZMIENIONE, „wystawiony” = dziś, odciski równe tym z generatora, „klucz …
   aplikacji = klucz w Kongu”, „GoTrue i PostgREST: ten sam sekret JWT”,
   `gotrue-serwis` i `postgrest-serwis` OK w obu kontenerach, health 200.
   **Ręcznie:** logowanie hasłem z 2FA i przez Google w zwykłej przeglądarce.
6. Sprzątanie: plik z generatora i kopie `.agents/backup/faktway-*/coolify-env.json`
   zawierają klucze; usuń je po udanej rotacji. Monitory (Uptime Kuma), które
   wołają `db.faktflow.pl` z kluczem anon, dostają nowy klucz.

Ustawienie bazy `app.settings.jwt_secret` (wpisywane przy pierwszym starcie
Supabase) zostaje stare: nasze migracje go nie czytają.

Cofnięcie: stare trzy wartości w usłudze Supabase (kopia z punktu 0.2) →
Restart usługi; w `id=1`/`id=2` stare wartości; worker Restart; aplikacja:
zakładka **Rollback** w Coolify, poprzedni obraz (ma stary klucz anon
wkompilowany), więc bez czekania na build. Zmienna repo w GitHub z powrotem.

## 4. `KSEF_CREDENTIALS_ENCRYPTION_KEY`

**Kod już to obsługuje, bez nowego PR** (AUD-52, sesja 27 planu skalowania):
- `lib/ksef/credentials-crypto.ts`: zapis v2 ma odcisk klucza głównego;
  szyfrowanie zawsze bieżącym `KSEF_CREDENTIALS_ENCRYPTION_KEY`, odczyt
  bieżącym albo `KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` (także stare v1);
- `scripts/reencrypt-ksef-credentials.ts` (logika w
  `lib/ksef/reencrypt-credentials.ts`): bez `--apply` tylko podgląd; z
  `--apply` przeszyfrowuje stronami po 200, zapis warunkowy na `updated_at`,
  pomija tylko zapisy już na bieżącym kluczu. Ponowienie jest bezpieczne.
  Testy: `tests/unit/credentials-crypto.test.ts`,
  `tests/unit/przeszyfrowanie-ksef-strony.test.ts`.

Kontrola po każdym kroku uruchamia ten podgląd w workerze, więc zawsze wiesz,
czy wszystkie zapisy odszyfrowują się kluczami z env.

**Najpierw ocena ryzyka.** Zmiana klucza nie unieważnia tokenów ani
certyfikatów KSeF firm. Kto miał stary klucz i stary klucz service_role,
mógł je odczytać. Kontrola wypisuje „firmy z zapisanymi danymi KSeF
(środowisko: liczba)”. Firmy z danymi dla środowiska `production` zapisanymi
przed 14.09.2026 poproś o unieważnienie tokenu w KSeF i wgranie nowego. Dane
dla `test`/`demo` nie dają dostępu do prawdziwych faktur.

1. `./scripts/ops/rotacja-generuj.sh hex KSEF_CREDENTIALS_ENCRYPTION_KEY`.
2. Coolify `id=2` i `id=1`, w obu przed jakimkolwiek restartem:
   `KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` = obecna wartość (skopiuj z pola
   `KSEF_CREDENTIALS_ENCRYPTION_KEY`), `KSEF_CREDENTIALS_ENCRYPTION_KEY` = nowa.
3. Restart **workera, potem aplikacji**. W tej kolejności worker zna oba
   klucze, zanim aplikacja zacznie szyfrować nowym; zlecenia KSeF przerwane
   restartem pg-boss ponowi.
4. Kontrola: „trwa rotacja klucza KSeF”, wszystkie zapisy się odszyfrowują,
   „N zapisów na starym kluczu”.
5. Przeszyfrowanie (jedyny krok z zapisem w bazie; rusza tylko przy zielonej
   spójności):

   ```bash
   ./scripts/ops/rotacja-kluczy.sh przeszyfruj-ksef
   ```

   Musi skończyć się „przeszyfrowanie zakończone kompletnie”, a podgląd
   „Do przeszyfrowania (podgląd): 0, … błędy: 0”. Inaczej uruchom ponownie.
6. Usuń `KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` z `id=2` i `id=1`, Restart
   workera, potem aplikacji, kontrola: zmiennej nie ma, wszystko się
   odszyfrowuje.
7. Stary klucz zostaw w menedżerze haseł z opisem „tylko do odtwarzania kopii
   bazy sprzed <data>” przez 60 dni (najdłuższa retencja kopii,
   `backup-restore.md`). Odtworzenie starej kopii: stary klucz do `_PREVIOUS`,
   potem punkt 5.

Cofnięcie przed punktem 6: zamień wartości miejscami (`KEY` = stary,
`_PREVIOUS` = nowy), Restart worker → aplikacja, punkt 5. Samo usunięcie
nowego klucza odcięłoby firmy, które w międzyczasie wgrały dane KSeF.

## 5. Inne sekrety, które mogły być w Vercelu

Pełna lista 42 nazw się nie zachowała (wartości były *Sensitive*, projekt
skasowany). Sprawdź w menedżerze haseł, co istniało przed 14.09.2026:

| Sekret | Co zrobić |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → nowy klucz, `id=1`/`id=2`, Restart, usuń stary. Bez przerwy. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | jeśli były: Stripe → Developers → API keys → *Roll key* z okresem ważności starego; webhook → *Roll secret* (stary ważny do 24 h). |
| `UPSTASH_REDIS_REST_*` | poza produkcją od migracji: usuń bazę albo token w Upstash. |
| `TELEGRAM_BOT_TOKEN` | jeśli był: BotFather → `/revoke` → nowy token w `id=1`/`id=2`. |
| `SENTRY_AUTH_TOKEN` | jeśli był: Sentry → Auth Tokens → unieważnij. DSN-y są jawne. |
| `VAPID_PRIVATE_KEY` | nie rotuj: nowa para kasuje wszystkie subskrypcje push, a do wysyłki trzeba adresów subskrypcji z bazy. |
| `GUS_API_KEY` | niskie ryzyko (dane publiczne); nowy klucz tylko na wniosek do GUS. |

## Po rotacji

- Usuń pliki z generatora (`.agents/backup/rotacja-kluczy/*.env`), kopie
  `.env.przed-rotacja-*` na `db-1` i kopie inwentarza z sekretami sprzed
  rotacji. Plik `odciski.txt` zostaje (same odciski).
- Wpis w `docs/security/` z datą i wynikiem ostatniej kontroli.
- Następna rotacja (prewencyjna, po odejściu osoby z dostępem, po
  incydencie) idzie tą samą drogą.
