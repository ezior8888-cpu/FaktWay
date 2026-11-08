# Onboarding — Pierwszy dzień w KSeF SaaS (Faza 35)

Dla nowego dewa / kolegi przejmującego projekt na czas urlopu solo-foundera.
Cel: po przeczytaniu + ~2 h setupu uruchamiasz aplikację lokalnie, rozumiesz
gdzie co jest i potrafisz wykonać typowe zadania.

## 1. Co to za projekt (TL;DR)

**FaktFlow** — SaaS dla mikrofirm/księgowych do wystawiania i odbierania
faktur VAT przez **KSeF 2.0** (polski rządowy system e-Faktur, mandatory
2026/2027). Multi-tenant, EU-only hosting, RODO + 10-letnia retencja.

Target: solo founder + 1 kolega support/QA. Launch: **luty 2027**.

Pełny stack i konwencje kodu: [AGENTS.md](../AGENTS.md).
Stan projektu i ukończone fazy: pamięć projektu (Bartosz ma w
`~/.claude/projects/.../memory/current_state.md`).

## 2. Setup lokalny (~45 min)

### Wymagania

- **Node 24+** (sprawdź: `node -v`)
- **pnpm 10.33+** (`packageManager` w `package.json`; instal: `npm i -g pnpm@10.33.0`)
- macOS / Linux (Windows przez WSL2)
- (opcjonalnie) **k6** dla loadtestów (`brew install k6`)
- (opcjonalnie) **Supabase CLI** dla lokalnej DB (`brew install supabase/tap/supabase`)

### Krok po kroku

```bash
# 1. Clone + install
git clone <repo-url> && cd ksef-saas
pnpm install --frozen-lockfile

# 2. Skopiuj env
cp .env.example .env.local
# Wypełnij wartości — solo founder daje Ci je w 1Password / Bitwarden

# 3. Sanity check
pnpm typecheck   # 0 errors
pnpm lint        # 0 errors (~28 pre-existing warnings — OK)
pnpm test        # XML/calculator/validator unit tests
```

### Uruchom apkę

```bash
# Terminal 1 — Next.js
pnpm dev
# → http://localhost:3000

# Terminal 2 — Inngest (background jobs)
pnpm inngest:dev
# → http://localhost:8288 (dashboard)
```

### Konto testowe

Zaloguj się na `test@faktflow.test` (hasło w 1Password). Onboarding wizard
poprowadzi przez seed danych (test NIP `1234567890`, KSeF env=test).

## 3. Co przeczytać najpierw (~1 h)

W kolejności:

1. **[AGENTS.md](../AGENTS.md)** — stack i konwencje (TypeScript strict,
   Server Components default, shadcn/ui, RLS wszędzie). KRYTYCZNE.
2. **[docs/architecture/system-overview.md](./architecture/system-overview.md)** —
   mapa komponentów, kto z kim gada.
3. **[docs/architecture/multi-tenant-rls.md](./architecture/multi-tenant-rls.md)** —
   filozofia izolacji tenantów. **Zanim napiszesz pierwszy `.from('invoices')`.**
4. **[docs/database-schema.md](./database-schema.md)** — 49 tabel pogrupowane domenowo.
5. **[docs/adr/README.md](./adr/README.md)** — 8 kluczowych decyzji
   architektonicznych z uzasadnieniem.
6. **[docs/runbooks/deploy-production.md](./runbooks/deploy-production.md)** —
   jak (i czego nie) deployować.

Diagram flow per domena: [ksef-flow](./architecture/ksef-flow.md),
[ocr-flow](./architecture/ocr-flow.md),
[billing-flow](./architecture/billing-flow.md).

## 4. Mapa repo

```
.
├── app/                        # Next.js App Router
│   ├── (auth)/                 # Login/register/forgot (niechronione)
│   ├── (dashboard)/            # Dashboard (chronione przez middleware)
│   ├── (marketing)/            # Landing, pricing, blog (statyczne)
│   ├── admin/                  # /admin/* — za ADMIN_EMAILS allowlist
│   ├── actions/                # Server Actions współdzielone
│   ├── api/                    # Route handlers (webhooki, health)
│   └── share-target/           # PWA Web Share (OCR upload)
├── components/                 # React (głównie shadcn/ui w components/ui)
├── content/help/               # 26 artykułów MDX (knowledge base, Faza 30)
├── design-tokens/              # Tailwind tokeny
├── docs/                       # ⭐ TUTAJ jesteś
│   ├── architecture/           # Diagramy Mermaid
│   ├── adr/                    # Architecture Decision Records
│   ├── runbooks/               # Procedury operacyjne
│   ├── security/               # OWASP, RTO/RPO
│   ├── support/                # Polityki / tone / escalation
│   └── analytics/              # Event dictionary (PostHog)
├── e2e/                        # Playwright
├── hooks/                      # React hooks
├── lib/                        # ⭐ CAŁA LOGIKA biznesowa
│   ├── ksef/                   # KSeF API client + auth
│   ├── xml/                    # FA(3) generator + validator XSD
│   ├── inngest/                # Jobs (lib/inngest/jobs/) + client
│   ├── supabase/               # Klienty server/admin/middleware/page-context
│   ├── analytics/              # PostHog tracking (client + server)
│   ├── billing/                # Stripe
│   ├── audit/                  # log() helper do audit_logs
│   ├── alerts/                 # Slack webhooks (3 kanały, Faza 27)
│   └── ...
├── load-tests/                 # k6 (Faza 34)
├── supabase/migrations/        # 55 migracji SQL (źródło prawdy)
├── tests/                      # Vitest (RLS isolation, mocki)
└── types/database.ts           # Generowane typy — NIE regeneruj sam!
```

## 5. Kluczowe pliki / koncepty

| Pytanie | Plik |
|---|---|
| Jak Server Action sięga do DB? | `lib/supabase/page-context.ts` (RLS) |
| Jak Inngest job sięga do DB? | `lib/supabase/admin.ts` (service_role) |
| Jak loguję audit? | `lib/audit/log.ts` |
| Jak alertuję Slack? | `lib/alerts/slack.ts` (3 kanały) |
| Jak cache'uję Redis? | `lib/cache/` (lookup-aside, SWR, TTL) |
| Jak generuję XML FA(3)? | `lib/xml/fa3-generator.ts` |
| Jak walidacja FA(3) XSD? | `lib/xml/validator.ts` (xmllint-wasm) |
| Gdzie env vars dokumentowane? | `.env.example` + `current_state.md` (memory) |

## 6. Typowe zadania

### Dodaj nową tabelę

1. `supabase/migrations/00056_<nazwa>.sql` (kolejny numer).
2. `CREATE TABLE` + `ENABLE ROW LEVEL SECURITY` + polityka RLS.
3. Indeksy (przemyśl hot-path).
4. Migrację na produkcję wgrywa Bartosz ręcznie — procedura w `AGENTS.md`, „Wgrywanie migracji na produkcję” (`pnpm db:push:prod` NIE działa: to pozostałość po Supabase Cloud).
5. Najpierw migracja, potem wdrożenie kodu (AGENTS.md, „Kolejność przy pełnym wydaniu”).

### Dodaj nowy Inngest job

1. `lib/inngest/jobs/<nazwa>.ts` (zob. `submit-invoice.ts` jako wzór).
2. Event w `lib/inngest/client.ts` (`zodEvent('domain/action', schema)`).
3. Rejestracja w `app/api/inngest/route.ts` (`functions: [...]`).
4. Test lokalnie z Inngest devem (terminal 2 wyżej).

### Dodaj nową stronę dashboardową

1. `app/(dashboard)/<route>/page.tsx` — Server Component.
2. `getPageContext()` dla supabase + tenantId.
3. Komponenty kliencki w `_components/` (z `'use client'` tylko gdy potrzeba).

### Pełna lista skryptów

```bash
pnpm dev / build / start         # Next
pnpm typecheck / lint            # Sanity
pnpm test / test:vitest / test:e2e
pnpm test:rls                    # Test izolacji tenantów
# migracje na produkcję: AGENTS.md (`pnpm db:push:prod` NIE działa)
pnpm inngest:dev                 # Inngest local dashboard
pnpm load:smoke / :run / :stress:* / perf:lighthouse   # Loadtesty (Faza 34)
pnpm ksef:test-auth / :test-token / :submit-full       # KSeF smoke
pnpm seed:tenant / :invoice      # Seed data
```

## 7. Dostępy zewnętrzne

Solo founder dodaje Cię do (zwykle przez SSO/invite):

- **GitHub** repo (write access).
- **Vercel** projekt (Developer role wystarcza dla deployów).
- **Supabase** projekt (Developer role + dostęp do bazy).
- **Stripe** dashboard (Developer role + read do `stripe_payments`).
- **Sentry** (Member dla projektu `javascript-nextjs`).
- **PostHog** (Member dla projektu EU Cloud).
- **Resend** (View dla maili).
- **Cloudflare** (R2 + Turnstile + Cache Rules — Restricted role).
- **Inngest** dashboard.
- **Redis** — bez osobnego panelu: własny Redis na `app-1` (zob. `AGENTS.md`, „Stack”); chmura Upstash nieużywana.
- **Slack** workspace + dostęp do `#urgent`, `#bugs`, `#metrics`.
- **1Password / Bitwarden** vault z env vars + KSeF credentials.

## 8. Pierwsze 30 dni — co robić

| Tydzień | Cel |
|---|---|
| 1 | Setup + przeczytaj wszystkie docs/, AGENTS.md, ostatnie 5 ADR |
| 2 | Cienkie tickety (kopia: rename, copy fix, mała feature) — czujesz repo |
| 3 | Średnie tickety (nowa Server Action / Inngest job) — czujesz wzorce |
| 4 | Pełen feature (Phase ticket end-to-end) — samodzielność |

## 9. Awaryjne

- **Apka padła na prod** → [docs/runbooks/disaster-recovery.md](./runbooks/disaster-recovery.md)
- **Klient nie może się zalogować** → [unlock-account.md](./runbooks/unlock-account.md)
- **Refund** → [refund-and-disputes.md](./runbooks/refund-and-disputes.md)
- **Sentry error niejasny** → [sentry-error-codes.md](./runbooks/sentry-error-codes.md)
- **Faktura odrzucona przez KSeF** → [ksef-error-codes.md](./runbooks/ksef-error-codes.md)
- **Coś o skalowaniu** → [scaling-triggers.md](./runbooks/scaling-triggers.md)

## 10. Tryb na wakacjach solo-foundera (worst case)

Solo founder zniknął na 2 tygodnie urlopu i nie odbiera.

- **P0 (DR / data loss)** → uruchamiasz scenariusze z
  `disaster-recovery.md`. Nie czekasz.
- **P1 (krytyczny bug klienta)** → fix + deploy zgodnie z
  `deploy-production.md`. Audyt po jego powrocie.
- **P2 (typowy ticket)** → odpowiadasz z `docs/support/` polityk +
  runbooków powyżej.
- **Decyzje strategiczne** (cennik, nowy feature, refund > 1000 PLN) →
  poczekaj na powrót, chyba że klient grozi prawnikiem.
