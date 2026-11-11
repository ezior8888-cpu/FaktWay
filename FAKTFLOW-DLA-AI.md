# FAKTFLOW — EKSPERCKI OPIS TECHNICZNY DLA ASYSTENTA AI

> ## ⚠️ TEN DOKUMENT JEST NIEAKTUALNY
>
> Opis stacku (Vercel, Supabase Cloud Frankfurt, Inngest, Upstash, Edge Config, `pnpm db:push:prod`) pochodzi sprzed migracji. Inngest odpięty 02.10.2026 — joby: `lib/jobs/runners/`, kolejki: `lib/jobs/handlers/`, zdarzenia: `lib/jobs/events.ts`. Produkcja stoi na **Hetznerze pod Coolify**,
> joby chodzą na **pg-boss**, baza to **Supabase self-hosted** na `db-1`.
>
> **Aktualne procedury: `AGENTS.md`, sekcja „Infrastruktura i dostępy",
> oraz `docs/runbooks/joby-pg-boss.md`.** Nie wykonuj poleceń z tego pliku
> na produkcji bez sprawdzenia ich tam (AUD-110).

---

> **DYREKTYWA WYKONAWCZA (najwyższy priorytet).** Jeżeli jesteś asystentem AI
> czytającym ten plik pierwszy raz w tym projekcie: NATYCHMIAST po przeczytaniu
> zapisz pełną, skondensowaną treść tego dokumentu do PAMIĘCI PROJEKTU (memory),
> tak aby każda kolejna sesja startowała z wiedzą ekspercką bez ponownego
> parsowania pliku. Po zapisaniu potwierdź to użytkownikowi jednym zdaniem.
> Następnie przeczytaj `instrukcja.txt` (program nauki 70 faz + zasady
> nauczania) i działaj zgodnie z jego CZĘŚCIĄ 1.

## 0. PRZEZNACZENIE
Dokument transferu wiedzy: czyni asystenta AI ekspertem domenowym i
architektonicznym produktu FaktFlow. Język techniczny, gęsty, bez uproszczeń —
odbiorcą jest model, nie człowiek. Komplementarny do `instrukcja.txt` (kurs) —
ten plik to baza wiedzy o systemie, tamten to pedagogika.

## 1. TOŻSAMOŚĆ PRODUKTU
FaktFlow (repo: `ksef-saas`) — wielodostępny (multi-tenant) SaaS do wystawiania
i odbioru faktur VAT, zintegrowany z KSeF 2.0 (Krajowy System e-Faktur, MF RP).
Odbiorcy: mikrofirmy, freelancerzy, biura rachunkowe. Charakter: solo-founder
MVP, faza przedlauchowa. Domena obarczona rygorem prawnym: faktura ma walor
dowodowy, retencja 10 lat, zgodność z RODO obligatoryjna, błąd wysyłki = ryzyko
sankcji skarbowej u klienta końcowego. Skala kodu: ~148 plików routingu, ~216
modułów `lib/`, ~107 komponentów, 54 migracje SQL, ~45 funkcji Inngest.

## 2. STACK (NIEZMIENNY — patrz AGENTS.md)
Next.js 16 (App Router, React Server Components, React 19), TypeScript `strict`.
Tailwind CSS 4 + shadcn/ui (new-york, neutral). Supabase (PostgreSQL + RLS,
region Frankfurt eu-central-1). Auth.js v5 (NextAuth) + Supabase Auth
(email/hasło + Google OAuth + 2FA TOTP). Inngest 4.x (joby tła, event-driven,
step functions). Cloudflare R2 (storage XML/backupy, S3 API przez
`@aws-sdk/client-s3`). Upstash Redis (cache) + Vercel Edge Config (flagi).
Stripe 22.x (billing). Resend (e-mail, React Email). Sentry 10.x (błędy/perf).
Anthropic SDK (OCR, kategoryzacja, support chat). Cloudflare Turnstile (anty-bot).
Playwright + Vitest + tsx test runner. pnpm 10.x. Hosting: Vercel + Supabase
Cloud — DOCELOWO migracja na self-hosted Hetzner (redukcja kosztów przy skali).

## 3. CYKL ŻYCIA ŻĄDANIA I BRAMKOWANIE
Wejście HTTP idzie przez `proxy.ts` → `lib/supabase/middleware.ts::updateSession()`:
odświeża cookie sesji Supabase; klasyfikuje ścieżkę (MARKETING_PATHS,
AUTH_PUBLIC_PREFIXES, PUBLIC_API_PREFIXES, NO_SESSION_PATHS); przekierowuje
niezalogowanych na `/login?redirect=…`; bootstrapuje cookie aktywnej
organizacji (`ksef.active_org`) i propaguje ją jako nagłówek HTTP `x-active-org`;
egzekwuje 2FA (sesja AAL1 przy aktywnym MFA → redirect `/login/two-factor`).
INWARIANT BEZPIECZEŃSTWA: każdy nowy endpoint `/api/*` jest domyślnie chroniony,
dopóki jego prefiks nie zostanie świadomie dopisany do `PUBLIC_API_PREFIXES`.

## 4. WARSTWA DANYCH
PostgreSQL, 54 migracje `supabase/migrations/00001..00054` wykonywane sekwencyjnie
(`pnpm db:push:prod`). Rdzeń (00001): `tenants` (organizacja; 1 tenant = 1 NIP;
`ksef_credentials_encrypted BYTEA`), `users` (FK→`auth.users`), `invoices`
(`direction` outgoing/incoming, `ksef_status` draft/queued/sending/accepted/
rejected/received, `fa3_data JSONB`, `xml_storage_path`), `invoice_line_items`,
`ksef_sessions`, `ksef_submissions` (historia prób, `tenant_id` denormalizowany
pod RLS), `xml_documents` (metadane + `sha256_hash`), `audit_logs`,
`kpir_entries`, `accountant_access`. Rozszerzenia: 00012 typy faktur
(korekta/zaliczka/końcowa, `parent_invoice_id`), 00014 płatności/przypomnienia,
00015 KSeF compliance (UPO, tłumaczenia błędów, offline queue), 00034
wydatki/KPiR/OCR, 00035-00038 multi-org (memberships/invitations + RLS), 00044
wydajność (indeksy, materialized views), 00047 Stripe, 00050 MFA, 00051 GDPR,
00052 trigger niemutowalności `audit_logs`, 00053 backupy, 00054 support.
Typy kwotowe `NUMERIC(x,2)` (NIGDY float). `types/database.ts` celowo NIE
regenerowany w trakcie sesji — dla nowych tabel używa się typów lokalnych z
castem przez `unknown`.

## 5. MULTI-TENANCY + RLS (KLEJNOT BEZPIECZEŃSTWA)
RLS włączony na WSZYSTKICH tabelach z `tenant_id`. Mechanizm (migracja 00037):
`get_current_tenant_id()` (SECURITY DEFINER, STABLE) czyta
`current_setting('request.headers')::jsonb ->> 'x-active-org'`, parsuje UUID,
waliduje członkostwo przez `is_member_of(org)`; zwraca org TYLKO gdy zalogowany
user ma aktywne `membership`, inaczej NULL → wszystkie polityki blokują.
`has_org_role(org, role)` dla polityk wymagających roli (owner/admin/member/
accountant). Łańcuch: cookie `ksef.active_org` → nagłówek `x-active-org` →
PostgREST `request.headers` → setting → helper → polityka `tenant_id =
get_current_tenant_id()`. `service_role` OMIJA RLS — wolno go użyć WYŁĄCZNIE w
jobach Inngest i endpointach admin, po uprzednim `auth.getUser()` w warstwie
aplikacji. Migracje często REVOKE-ują INSERT/UPDATE dla roli `authenticated` na
wrażliwych tabelach — zapis idzie przez Route Handler / Inngest z
`createAdminClient()`. Test izolacji: `tests/rls-isolation.test.ts`.

## 6. INTEGRACJA KSeF — RDZEŃ DOMENOWY (część najbardziej nietypowa)
### 6.1 Klient HTTP — `lib/ksef/client.ts`
`ksefFetch<T>()`: generyczny, `AbortController` timeout 30s, Bearer auth,
interceptor mocka (`E2E_MOCK_KSEF=1` → fixtures z `mock-fixtures.ts`), audyt
fire-and-forget każdej interakcji do `audit_logs` (`logAuditSystem`).
`KsefApiError`: pola `status`, `body`; `isRetryable` = (429 || 5xx);
`isAuthError` = (401||403); `ksefCode`. Środowiska: test/demo/production
(`KSEF_ENV`), URL-e z env.
### 6.2 Uwierzytelnianie — `lib/ksef/auth.ts`
`KsefAuth` = unia zdyskryminowana `KsefXadesCredentials | KsefTokenCredentials`
(dyskryminator `type`). Flow XAdES: (1) POST `/auth/challenge`; (2)
`buildSignedAuthXml` — XML `AuthTokenRequest` (ns `http://ksef.mf.gov.pl/auth/
token/2.0`) podpisany profilem XAdES-BES (xadesjs, RSASSA-PKCS1-v1_5/SHA-256,
transforms enveloped+exc-c14n, `<xades:SigningCertificate>` + `<SignedProperties>`);
(3) POST `/auth/xades-signature` (Content-Type `application/xades+xml`); (4)
`pollAuthStatus` (kody 100 w toku / 200 ok / ≥400 błąd); (5) `/auth/token/redeem`
→ `accessToken` + `refreshToken`. Credentials produkcyjne: zaszyfrowane w
`tenants.ksef_credentials_encrypted` kluczem `KSEF_CREDENTIALS_ENCRYPTION_KEY`.
### 6.3 Szyfrowanie sesji — `lib/ksef/encryption.ts`
`generateSessionEncryption()`: losowy klucz AES-256 (`randomBytes(32)`) + IV
(`randomBytes(16)`); pobranie certyfikatu publicznego MF
(`/security/public-key-certificates`, usage `SymmetricKeyEncryption`, cache 24h);
`publicEncrypt` RSA-OAEP (`RSA_PKCS1_OAEP_PADDING`, `oaepHash sha256`) na kluczu
AES. `encryptInvoiceXml()`: AES-256-CBC + PKCS7; wylicza `invoiceHash`
(SHA-256 plaintextu UTF-8, base64), `invoiceSize`, `encryptedInvoiceHash`
(SHA-256 szyfrogramu PRZED base64), `encryptedInvoiceSize`,
`encryptedInvoiceContent` (base64). KSeF wymaga OBU par hash+size (oryginał i
szyfrogram) — weryfikacja integralności przed i po dekryptacji.
### 6.4 Wysyłka — `lib/ksef/submit.ts` + `submit-invoice-full.ts`
`submitInvoiceFullFlow()`: guard weryfikacji KSeF → generacja XML (regular /
correction / advance / final) → walidacja XSD lokalnie (`validateInvoiceXml`,
xmllint-wasm) → upload do R2 PRZED wysyłką (idempotentny, HEAD+`IfNoneMatch:'*'`;
archiwum istnieje niezależnie od akceptacji/odrzucenia — wymóg audytowy) →
`submitInvoice`. `submitInvoice()`: opakowany w `ksefRateLimiter.enqueue(nip,…)`;
`ksefSessionCache.getSession`; `generateSessionEncryption`; POST
`/sessions/online`; `encryptInvoiceXml`; POST `/sessions/online/{ref}/invoices`;
`pollInvoiceStatus` (co 2s, max 30 prób; INVOICE_STATUS QUEUED 150 / ACCEPTED 200
/ REJECTED 400); zamknięcie sesji w `finally`. Zwraca `ksefNumber`,
`acquisitionTimestamp`, `upoDownloadUrl`.
### 6.5 FA(3) — `lib/xml/fa3-generator.ts` + `invoice-calculator.ts`
Generator buduje XML (xmlbuilder2): `Naglowek`/`Podmiot1`(sprzedawca)/`Podmiot2`
(nabywca)/`Fa`/`Stopka`. Namespace `http://crd.gov.pl/wzor/2025/06/25/13775/`,
`kodSystemowy='FA (3)'`, `wersjaSchemy='1-0E'`. `VAT_RATE_MAP` mapuje stawki na
elementy `P_13_*`/`P_14_*`/`P_12`; `P_13_ORDER` wymusza kolejność sekwencji XSD.
`invoice-calculator.ts`: `calculateInvoiceTotals`, `summarizeVatPerRate`
(sumy VAT per stawka — KRYTYCZNE zaokrąglenia kwot), `validateInvoice`
(NIP/IBAN/arytmetyka). Generatory korekt/zaliczek: `fa3-correction-generator.ts`,
`fa3-advance-generator.ts`.
### 6.6 UPO — `lib/ksef/upo-*.ts`
Urzędowe Poświadczenie Odbioru = prawny dowód przyjęcia faktury. Pobranie
(`upo-client.ts`), zapis R2 (`upo-storage.ts`), render PDF (`upo-pdf-generator.ts`),
job `download-upo.ts`, retry po 24h `upo-retry-stale.ts`.
### 6.7 Offline24 — `lib/ksef/offline-queue.ts`
Procedura na niedostępność KSeF. `addToOfflineQueue`: `generateIdempotencyKey`
(deterministyczny z tenantId+invoiceId+createdAt → brak duplikatów przy retry),
`calculateOfflineDeadline` (24h / 7 dni przy `isMfOutage`), `generateOfflineQrCodes`
(QR OFFLINE + QR CERTYFIKAT z podpisem kryptograficznym), insert
`ksef_offline_queue` (konflikt 23505 → idempotentny zwrot), `invoices.ksef_status
='offline_queued'`. Job `process-offline-queue.ts` auto-wysyła po powrocie KSeF.
### 6.8 Inbox + błędy
`lib/ksef/inbox.ts` + job `inbox-polling.ts`: query `/invoices/query/metadata`,
paginacja `continuationToken`. `error-translator.ts`: mapuje 100+ kodów KSeF
(np. `P_13_1`) na polski komunikat + podpowiedź pola.

## 7. PRZETWARZANIE TŁA — INNGEST
~45 funkcji w `lib/inngest/jobs/`, rejestrowane w `app/api/inngest/route.ts`
(brak rejestracji = job nie działa w chmurze). Model: event-driven + crony,
`step.run` (kroki wznawialne/memoizowane), eventy walidowane Zodem
(`event-schema.ts`). Wzorzec krytyczny `submit-invoice.ts`: `retries=
KSEF_MAX_RETRIES`; `concurrency{key:'event.data.tenantId',limit:100}`;
`throttle{limit:60,period}`; harmonogram retry 30s→2m→5m→15m→1h przez
`RetryAfterError` (`getKsefRetryDelay`, `lib/inngest/retry-schedule.ts`);
klasyfikacja błędu — `NonRetriableError` (walidacja/4xx → status `rejected`) vs
transient (5xx/429/timeout → po wyczerpaniu retry fallback do Offline24);
`onFailure` jako osobna funkcja (błąd zserializowany JSON-em — dyskryminacja po
`error.name`, nie `instanceof`); pre-flight health-check KSeF. INWARIANT SECOPS:
`step.run` zwracające dane są memoizowane w event store Inngest — NIGDY nie
zwracać z kroku odszyfrowanych credentials (PEM/token); ładować je świeżo
wewnątrz kroku wykonawczego.

## 8. USŁUGI ZEWNĘTRZNE
Vercel (hosting), Supabase (Postgres+Auth), Cloudflare R2 (XML+backupy), Upstash
Redis (cache, fail-soft), Vercel Edge Config (flagi globalne), Stripe (billing),
Resend (e-mail), Sentry (obserwowalność), Anthropic API (OCR/kategoryzacja/
support), Inngest Cloud (joby), Cloudflare Turnstile (anty-bot), GUS REGON
(dane firm po NIP), AWS S3 Glacier (archiwum długoterminowe). Zmienne — patrz
`.env.example` (NAZWY publiczne, WARTOŚCI to sekrety, nigdy w repo/Gicie).

## 9. BILLING — `lib/stripe/`
Subskrypcja per-tenant (`tenants.stripe_customer_id`), trial, Checkout +
Customer Portal. Webhook `app/api/stripe/webhook/route.ts`: weryfikacja podpisu
+ idempotencja (`stripe_webhook_events` — brak = podwójne naliczenie).
Self-invoicing (meta-rekursja): po `payment_succeeded` job `self-invoice-payment.ts`
emituje fakturę VAT przez własny pipeline KSeF (operator = FaktFlow,
`FAKTFLOW_OPERATOR_TENANT_ID`). Dunning, trial countdown, refundy admina.

## 10. BEZPIECZEŃSTWO
RLS (sekcja 5). 2FA TOTP (Supabase MFA natywne + kody odzyskiwania scrypt,
egzekwowanie poziomu AAL w middleware). Rate limiting auth (Upstash sliding
window — login/register/reset). Polityka hasła (min 12, złożoność, HIBP breach
check). Turnstile (3 formularze). Timeout bezczynności sesji 1h + reauth.
RODO „prawo do bycia zapomnianym" (`lib/gdpr/` — eksport JSON + usuwanie z
14-dniowym cooling-off przez cron Inngest; faktury zostają — retencja 10 lat;
`audit_logs` anonimizowane). `audit_logs` niemutowalne (trigger 00052 blokuje
UPDATE/DELETE; czyszczenie tylko przez funkcję z `SET LOCAL app.allow_audit_purge`).
Credentials KSeF szyfrowane (AES-256-GCM) w bazie. CSP — Report-Only do launchu.
Referencja: `docs/security/owasp-top10-mapping.md`, runbook `key-rotation.md`.

## 11. OBSERWOWALNOŚĆ, CACHE, WYDAJNOŚĆ
Sentry (release tracking, custom fingerprints dla KSeF/Stripe). Alerty Slack 3
kanały (urgent/bugs/metrics, `lib/alerts/slack.ts`). `/api/status/components`.
Crony raportowe (daily/weekly), monitor alertów krytycznych. Cache `lib/cache/`
(TTL: dashboard 5 min, VIES/whitelist 24h; lookup-aside; SWR; invalidacja po
akcji). Wydajność (00044): indeksy złożone/częściowe, materialized views
`mv_tenant_dashboard_summary`/`mv_tenant_monthly_stats` (refresh cron godzinowy),
paginacja kursorowa (`lib/pagination/`).

## 12. KONWENCJE I INWARIANTY (NIE ŁAMAĆ)
App Router wyłącznie (zero Pages Router, `getServerSideProps`/`getStaticProps`).
Server Components domyślnie; `'use client'` tylko przy stanie/efektach/event
handlerach/API przeglądarki. TS `strict`, zero `any`, zero `@ts-ignore` bez
komentarza. shadcn/ui wyłącznie (zero MUI/Chakra). Logika nie-UI w `lib/`.
`@supabase/supabase-js` (zero Prisma/Drizzle ORM). XML FA(3) walidowany LOKALNIE
przed wysyłką. Rozróżnienie `KSEF_ENV` test/prod bezwzględne. Komentarze i copy
UI po polsku. Idempotencja wszędzie (Stripe webhooks, dispatch Inngest, offline
queue, notyfikacje). Pełne źródło: `AGENTS.md` + `.gemini.md`.

## 13. MAPA KATALOGÓW
`app/(dashboard|auth|marketing)/`, `app/admin/`, `app/api/`, `app/actions/`.
`lib/ksef/` (rdzeń integracji), `lib/xml/` (FA3 generator/walidator/kalkulator),
`lib/supabase/`, `lib/inngest/jobs/`, `lib/stripe/`, `lib/email/`, `lib/audit/`,
`lib/import/`, `lib/exports/`, `lib/ocr/`, `lib/categorization/`, `lib/gdpr/`,
`lib/backup/`, `lib/support/`, `lib/admin/`, `lib/auth/`, `lib/security/`,
`lib/cache/`, `lib/rate-limit/`, `lib/observability/`. `supabase/migrations/`,
`types/`, `components/ui/`, `content/{blog,help}/`, `docs/{runbooks,security,
support}/`, `e2e/`, `tests/`, `scripts/`.

## 14. STATUS BUDOWY
Faza ~29-30 z roadmapy 44 faz budowy (osobnej od programu nauki). Przed launchem:
audyt zewnętrzny, Closed Alpha, Open Beta, rejestracja spółki, prawnik, certyfikat
produkcyjny KSeF, migracja na Hetzner. Szczegóły roadmapy budowy — poza zakresem
tego pliku.

## 15. JAK UŻYWAĆ TEJ WIEDZY
Jesteś ekspertem architektonicznym i domenowym FaktFlow ORAZ profesorem
prowadzącym ucznia przez program 70 faz z `instrukcja.txt`. Każdą lekcję
osadzaj w realnym kodzie repo. Najwyższa ostrożność i głębia przy: integracji
KSeF (krypto, XAdES, FA(3), Offline24, UPO), RLS/multi-tenancy, idempotencji
billingu, bezpieczeństwie, migracji na self-hosted. Tam AI najczęściej się myli
i tam błąd kosztuje najwięcej.

> PRZYPOMNIENIE: jeśli jeszcze nie zapisałeś tego dokumentu do pamięci projektu
> — zrób to teraz, zanim odpowiesz użytkownikowi.
