> ## ⚠️ TEN DOKUMENT JEST NIEAKTUALNY
>
> Opisuje wdrożenia przez **Vercela**, z którego zrezygnowaliśmy w sierpniu
> 2026. Produkcja stoi teraz na **Hetznerze pod Coolify**.
>
> **Aktualna procedura: [`wdrozenie-produkcji.md`](wdrozenie-produkcji.md)** (niezmienniki: `AGENTS.md`, „Infrastruktura i dostępy").
>
> Zostawiony wyłącznie jako zapis tego, jak było. Nie wykonuj poleceń
> z tego pliku na produkcji.

---

# Deploy to Production Runbook (Faza 35)

Procedura wypuszczania zmian na produkcję. Od checkout po smoke test.
Cel: kolega zrobi pierwszy deploy bez Twojej pomocy.

## TL;DR

```bash
# 1. Sprawdź zielony CI
gh pr view --web  # PR merged do main?

# 2. Migracje (jeśli są)
pnpm db:push:prod:dry      # podgląd
pnpm db:push:prod          # właściwy push

# 3. Code deploy
git push origin main       # Vercel auto-deploy (~3 min)

# 4. Smoke test
curl https://faktflow.pl/api/health
```

Jeśli któryś krok się sypie → sekcja "Rollback" niżej.

---

## Pre-deploy checklist

Przed mergem do `main`:

- [ ] **CI zielony** — typecheck + lint + test + test:vitest + e2e w GitHub Actions.
- [ ] **Migracje sprawdzone** — `pnpm db:push:prod:dry` lokalnie pokazał oczekiwane DDL.
- [ ] **Env vars** — jeśli PR dodaje nowy env, jest w Vercel **przed** mergem
      (Settings → Environment Variables → Production).
- [ ] **PR description** wymienia: co się zmienia, breaking changes, migracje,
      nowe env, jak rollback'ować.
- [ ] **Bundle nie urósł nieproporcjonalnie** — `pnpm build` pokazał shared
      First Load JS bliski 310 KB (zob. [performance-budget](../performance-budget.md)).

## Krok 1 — Migracje

Jeśli PR zawiera nową migrację w `supabase/migrations/`:

```bash
# Podgląd — pokazuje DIFF SQL, nic nie wykonuje
pnpm db:push:prod:dry

# Wykonaj — zapyta o potwierdzenie
pnpm db:push:prod
```

⚠️ **Migracje przed deployem kodu**, nie po — żeby kod widział już nowe
kolumny/tabele. (Wyjątek: rename / drop kolumny — wtedy kod **najpierw**
przestaje używać kolumny, deploy, **potem** migracja).

Wymagane env w `.env.local` dla `db:push:prod`:
- `SUPABASE_PROD_DB_URL` — connection string Postgres (z Supabase dashboardu, role: postgres / service)
- `SUPABASE_ACCESS_TOKEN` — z `supabase login`

Po wykonaniu — sprawdź migrację w Supabase dashboard → Database → Migrations.

## Krok 2 — Deploy kodu

```bash
# Po mergu PR do main
git checkout main && git pull
```

Vercel auto-deploy startuje na pushu do `main`:
- Build: ~2-3 min (z buildem RSC + Sentry source maps).
- Promotion na prod: automatyczne (Production Branch = `main`).
- URL: `https://faktflow.pl` (alias kanonicznego deploya).

Możesz obserwować w Vercel dashboard → Deployments → najnowszy.

## Krok 3 — Smoke test (3 minuty)

Tuż po promotion:

```bash
# Health endpoint — szybki check
curl https://faktflow.pl/api/health
# → {"ok":true,...}

# Status komponentów (Faza 27)
curl https://faktflow.pl/api/status/components | jq
# → KSeF, DB, Redis powinny być "ok"
```

W przeglądarce (ręcznie):
- [ ] `/login` — formularz się renderuje, Turnstile widget się ładuje.
- [ ] Zaloguj się testowym kontem owner — `/dashboard` ładuje się < 2 s.
- [ ] Wystaw testową fakturę (test NIP `1234567890`, `KSEF_ENV` powinien być
      `production` ale fakturę wystawiamy do test-faktur z UI testing).
      Sprawdź że trafia do KSeF (status zmienia się z draft → submitted).
- [ ] `/admin/system` (jeśli jesteś w `ADMIN_EMAILS`) — Inngest jobs, DB stats,
      KSeF health wszystko zielone.

## Krok 4 — Verify (po 10 minutach)

- **Sentry**: Dashboards → Releases → najnowszy commit SHA tagged. Brak spike
  errorów vs poprzedni release.
- **PostHog**: zdarzenia napływają (event-feed), brak nagłego drop in pageviews.
- **Vercel Logs**: brak spike `5xx` w Functions tab.

---

## Rollback

### Jeśli zepsuło się po deployu kodu (bez migracji)

1. Vercel dashboard → Deployments → poprzedni działający → **Promote to Production**. (~1 min).
2. Komunikat Slack `#urgent`: "Rollback do <commit SHA>, root cause TBD".
3. Otwórz incident issue z linkiem do problematycznego PR.

### Jeśli migracja zepsuła schema

**Najgorszy scenariusz** — migracje są nieodwracalne (chyba że masz down
migration, której zwykle nie piszemy).

1. Sprawdź `docs/runbooks/backup-restore.md` — najnowszy zrzut `pg_dump` w `/root/backups/daily` na `db-1`.
2. Jeśli zmiana jest dodawanie (ADD COLUMN, CREATE TABLE) — nie zrywamy, kod
   może działać bez nowych kolumn jeśli ich nie używał. Zrób revert kodu
   (powyżej) i ZOSTAW migrację — naprawisz na spokojnie.
3. Jeśli zmiana jest destrukcyjna (DROP COLUMN, ALTER TYPE) — pełny restore
   z snapshotu (RTO ~2h, RPO ~24h). Tutaj decyduje rachunek strat:
   "ile danych stracimy z 24h?" vs "ile czasu kosztuje hotfix migracji?".

### Jeśli migracja nie poszła (błąd w trakcie `pnpm db:push:prod`)

Supabase wykonuje migrację w transakcji — błąd = ROLLBACK, schema bez zmian.
Napraw SQL, ponów. Nic nie potrzeba odkręcać.

---

## Co NIGDY nie robić

- ❌ Deploy w piątek po południu (kolega nie odbierze pagera).
- ❌ Deploy bez `pnpm db:push:prod:dry` najpierw.
- ❌ Deploy z lokalnej maszyny (Vercel CLI manual) — zawsze przez git push.
- ❌ Migrację destrukcyjną bez weryfikacji że backup z dziś jest OK.
- ❌ Edytować env w Vercel po deployu i "zobaczyć czy działa" — najpierw
  staging/preview, dopiero potem prod.

## Powiązane runbooki

- [backup-restore.md](./backup-restore.md) — odtworzenie bazy ze zrzutu `pg_dump`
- [disaster-recovery.md](./disaster-recovery.md) — 7 scenariuszy awarii
- [scaling-triggers.md](./scaling-triggers.md) — gdy deploy ujawnia bottleneck
