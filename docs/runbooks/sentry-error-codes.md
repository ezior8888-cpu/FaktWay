# Sentry Error Codes Reference (Faza 35)

> ## ⚠️ TEN DOKUMENT JEST NIEAKTUALNY
>
> Część sekcji (Inngest dashboard, zmienne w Vercelu) opisuje dawną infrastrukturę; kody błędów i ich znaczenie są aktualne. Produkcja stoi na **Hetznerze pod Coolify**,
> joby chodzą na **pg-boss**, baza to **Supabase self-hosted** na `db-1`.
>
> **Aktualne procedury: `AGENTS.md`, sekcja „Infrastruktura i dostępy",
> oraz `docs/runbooks/joby-pg-boss.md`.** Nie wykonuj poleceń z tego pliku
> na produkcji bez sprawdzenia ich tam (AUD-110).

---

Najczęstsze patterny błędów w Sentry + co znaczą + jak naprawić. Lookup
dla "kolega widzi error w Sentry, nie wie co dalej".

Faza 27 ustawiła **custom fingerprints** (`lib/observability/sentry-context.ts`)
żeby błędy KSeF / Stripe grupowały się sensownie. Patrz tagi w Sentry:
`area:ksef`, `area:billing`, `area:ocr`, `area:auth`.

## Quick lookup

| Symbol w Sentry | Obszar | Sekcja |
|---|---|---|
| `NonRetriableError` | Inngest job | §1 |
| `KSeFRejectedError` | KSeF submit | §2 |
| `KSeFAuthError` | KSeF auth | §3 |
| `PostgrestError` (RLS, 406, 409) | Supabase | §4 |
| `pool exhausted` / connection timeout | Supabase pooler | §4 |
| `StripeSignatureVerificationError` | Stripe webhook | §5 |
| `Anthropic*Error` | OCR / support chat | §6 |
| `ChunkLoadError`, `Loading chunk N failed` | Build / cache | §7 |
| `AAL2 required` | Auth (2FA enforcement) | §8 |

> `ChunkLoadError`, `NEXT_NOT_FOUND`, `NEXT_REDIRECT`, `ResizeObserver loop` —
> są w `ignoreErrors` w `instrumentation-client.ts`. Jeśli widzisz mimo to,
> sprawdź czy nie zostały usunięte z listy.

---

## §1. NonRetriableError (Inngest)

**Co to:** Job Inngest świadomie się poddał — nie ma sensu retry'ować
(bad input, brak rekordu w DB, walidacja). Implementuje `inngest.NonRetriableError`.

**Najczęstsze przyczyny:**
- `submit-invoice`: brak `invoiceId` w DB (race condition — delete przed
  wykonaniem), nieprawidłowy NIP, walidacja XSD FA(3) zawiodła.
- `process-ocr`: brak `ocrJobId`, plik nie istnieje w R2.

**Co zrobić:**
1. Wejdź w event w Inngest dashboardzie — payload pokazuje IDs.
2. Sprawdź w DB czy rekord istnieje:
   ```sql
   SELECT * FROM invoices WHERE id = '<invoiceId>';
   SELECT * FROM ocr_jobs WHERE id = '<ocrJobId>';
   ```
3. Jeśli faktycznie usunięty — `NonRetriableError` był słuszny. Zignoruj.
4. Jeśli istnieje, a job mówi że nie — race condition lub bug w kodzie.
   Otwórz issue.

## §2. KSeFRejectedError (4xx od KSeF)

**Co to:** KSeF odrzucił fakturę z błędem 4xx. **Faza 23 traktuje to jako
NonRetriable** — błąd jest po naszej stronie (zła walidacja, błędny NIP,
duplikat numeru wewnętrznego).

**Najczęstsze:**
- `21100` — invalid signature (zły tenant credentials).
- `21202` — KSeF rejected schema (XSD niezgodny, sprawdź FA(3) version).
- `21270` — duplicate invoice number (próba ponownej wysyłki z tym samym
  `internal_number`).

Pełne mapowanie kodów → polskie komunikaty: [ksef-error-codes.md](./ksef-error-codes.md).

**Co zrobić:**
1. Sprawdź `ksef_submissions` w DB: `error_code` to kod HTTP albo statusu
   KSeF. Treści odpowiedzi KSeF tam nie ma, w Sentry i logach też nie
   (F-093-STATUS: walidator KSeF może powtarzać dane z dokumentu). Przy
   odrzuceniu w statusie (np. 450) opis i szczegóły KSeF są tylko
   w `invoices.last_error`: karta faktury klienta, `/admin/ksef/<id>`
   (ramka pod danymi faktury) i `/admin/support`.
2. Pokaż user-owi błąd w UI (już robimy w `/invoices/[id]`).
3. Jeśli to bug walidacji — fix XML generator + retest na `KSEF_ENV=test`.

## §3. KSeFAuthError

**Co to:** Auth flow KSeF padł (challenge → token wymiana zawiodła).

**Najczęstsze:**
- Token wygasł (sesja KSeF). Zwykle `lib/ksef/auth.ts` auto-refreshuje.
- Bad credentials tenanta — `KSEF_CREDENTIALS_ENCRYPTION_KEY` rotated bez
  re-encrypt istniejących? Patrz [key-rotation.md](./key-rotation.md).
- KSeF down (5xx) — szyfrowany retry.

**Co zrobić:**
1. Sprawdź `ksef_health_log` — czy KSeF żył w tym czasie.
2. Sprawdź `ksef_sessions` dla tego tenanta — `expires_at` w przeszłości?
3. Jeśli masowo dla wszystkich tenantów — KSeF problem, czekaj +
   alert `#urgent`.

## §4. PostgrestError + connection issues

**RLS-related (status 406 / 409 / "permission denied for ..."):**
- Kod używa session client gdzie powinien admin client (np. cross-tenant query).
- Polityka RLS się rozjechała z kodem — sprawdź ostatnią migrację.

**Connection pool exhausted:**
- "remaining connection slots are reserved" — pooler Supabase wyczerpany.
- Zwykle spike loadu → patrz [scaling-triggers.md](./scaling-triggers.md) §Supabase.

**Co zrobić:**
1. Errror message → konkretna tabela / operacja.
2. Sprawdź czy RLS policy istnieje: `SELECT * FROM pg_policies WHERE tablename = '...'`.
3. Pooler exhausted → upgrade plan compute add-on Supabase.

## §5. StripeSignatureVerificationError

**Co to:** Webhook Stripe nie ma poprawnego podpisu — albo `STRIPE_WEBHOOK_SECRET`
się rozjechał, albo ktoś próbuje fake'ować webhook.

**Co zrobić:**
1. Sprawdź `STRIPE_WEBHOOK_SECRET` w Vercel env vs Stripe Dashboard → Webhooks →
   endpoint → Signing secret.
2. Po rotacji — zaktualizuj env w Vercel (nie commituj!) + redeploy.
3. Jeśli signature OK ale errror inny — patrz `stripe_webhook_events` w DB,
   tam zapisany payload.

## §6. Anthropic errors (OCR / support chat)

**Najczęstsze:**
- `429 rate_limit_error` — wycieliśmy limit Claude. Job `processOcr` ma
  `concurrency: { limit: 5 }`, ale przy spike może uderzyć w org limit.
- `overloaded_error` — Anthropic ma problem, retry powinien zadziałać.
- `invalid_request_error` — payload za duży (zdjęcie > ~5 MB) lub złe formaty.

**Co zrobić:**
1. Sprawdź Anthropic status page.
2. Dla `429` z naszej strony — patrz `lib/jobs/runners/process-ocr.ts` concurrency.
3. Dla `invalid_request` — sprawdź size zdjęcia w `expenses.image_path`.

## §7. ChunkLoadError / "Loading chunk N failed"

**Co to:** Klient ma starą wersję JS, kliknął coś co prosi o chunk którego już
nie ma (po deployu nowe hashe).

**Już ignorujemy** w `instrumentation-client.ts` — nie ma czego naprawiać poza
"force reload" klienta. Serwis worker (Faza 17) próbuje auto-reload.

**Jeśli spike** — możliwe że promotion deploya zerwał cache CDN. Sprawdź
Cloudflare cache purge.

## §8. AAL2 required

**Co to:** Middleware (Faza 28) wymaga `aal2` na sensitive routes
(`/settings/security`, `/settings/billing`, `/admin/*`), a user ma tylko `aal1`.

**Zwykle:**
- User próbuje wejść na sensitive route bez 2FA — przekierowanie na
  `/login/two-factor`. Sentry loguje to **info-level**, nie error.

**Jeśli error** — middleware nie potrafi pobrać sesji (bug w
`lib/supabase/middleware.ts`). Patrz Sentry breadcrumb przed tym eventem.

---

## Custom fingerprints (jak grupujemy)

`lib/observability/sentry-context.ts` ustawia:
- `area:ksef` → grupowanie per `ksef_error_code` (nie per stack trace) —
  dzięki temu wszystkie `21202` lecą do jednego issue.
- `area:billing` → grupowanie per `stripe_event_type`.
- `area:ocr` → grupowanie per `anthropic_error_type`.

Bez tego Sentry grupowałby per linia kodu — i każda faktura odrzucona przez
KSeF byłaby osobnym issue (zalewałoby dashboard).

## Powiązane

- [ksef-error-codes.md](./ksef-error-codes.md) — lookup kodów KSeF
- [docs/architecture/ksef-flow.md](../architecture/ksef-flow.md)
- `lib/observability/sentry-context.ts` — fingerprints
- `lib/alerts/slack.ts` — alerty per area
