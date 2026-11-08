# Plan usprawnień pracy (Claude, Codex, CI, wdrożenia)

> **„Kontynuuj plan usprawnień”**: przeczytaj ten plik, zrób checklistę
> (sekcja 0) i pracuj od „Następny krok” na końcu dziennika (sekcja 7).
> Jeden punkt = jedna gałąź `claude/usp-<etap>-<temat>` = jeden PR. Po etapie
> raport i stop (punkt 10 protokołu w `AGENTS.md`).

## Po co ten plan

Zlecenie Bartosza (03.11.2026, „zrobimy to wszystko”): praca w FaktWay ma być
przyjemniejsza, kod lepszy, błędów jak najmniej, a Claude ma myśleć szeroko,
a nie według coraz dłuższej listy reguł. Analiza: 04.11.2026, `main` @ `7a249d3f`.

## 0. Checklista startowa (każda sesja)

1. `git fetch origin`, gałąź od `origin/main`. Nigdy od lokalnego `main`.
2. `bash scripts/dev/przygotuj-worktree.sh` (po scaleniu PR z etapu 1 robi to
   sam hook SessionStart).
3. Przeczytaj w `AGENTS.md` „Protokół naprawy błędu” i „Co NIE robić”.
4. `gh pr list --state open --json number,title,headRefName,files` i sprawdź,
   czy nikt nie rusza Twoich plików.
5. Sprawdź, czy punkt nadal ma sens: `main` idzie do przodu.

## 1. Zasady tego planu

1. **Nie zawężać myślenia Claude.** Ładowane zawsze (`AGENTS.md`, indeks
   pamięci) zawiera tylko niezmienniki, bezpieczeństwo i stos. Procedury są
   w `docs/runbooks/` i ładują się na żądanie. Co da się sprawdzić automatem
   (hook, skrypt, test, CI), sprawdza automat, a reguła w prompcie znika.
2. **Hooki są szybkie i milczą, gdy wszystko gra.** Odzywają się jedną linią,
   gdy coś zrobiły albo coś jest czerwone.
3. **Codex Igora czyta `AGENTS.md`, nie zna skilli Claude.** Skill to cienka
   nakładka (kilka linii) z odnośnikiem do runbooka, nigdy jedyne miejsce
   procedury. Żadnych gotowych paczek skilli z internetu.
4. **Tanio.** Rutynę robią skrypty i harmonogram; Claude wchodzi, gdy coś jest
   czerwone. Subagenty: Sonnet do mechanicznego, Opus do projektu, SQL
   i recenzji.
5. **Poza repo nic bez zgody.** Globalne ustawienia Claude, aplikacja Claude,
   GitHub (aplikacje, reguły gałęzi), serwery, Coolify, usuwanie pamięci:
   sesja pokazuje dokładną zmianę (sekcja 5) i czeka.
6. **Mac zamrożony.** Zmiany na telefon tylko za `max-sm:`/`sm:` albo
   `@media (hover: none) and (pointer: coarse)`.

## 2. Fakty sprawdzone 04.11.2026

| Fakt z przeglądu 03.11 | Stan 04.11 |
|---|---|
| `AGENTS.md` 4 301 słów, 644 linie | potwierdzone |
| `MEMORY.md` 1 340 słów, 43 pliki pamięci | potwierdzone; ok. 32 tys. słów w plikach, z czego 14 tys. w trzech starych (fazy, masterplan, migracja Hetzner). Indeks ładuje się zawsze, pliki na żądanie |
| pluginy `gitlab`, `github` (MCP: zły nagłówek), `posthog`, `logo-design` | potwierdzone; do tego plugin `design` z aplikacji z 7 serwerami MCP bez logowania (Asana, Atlassian, Figma, Intercom, Linear, Notion, Slack) |
| `.claude/` poza gitem, zero hooków | potwierdzone |
| Renovate nigdy nie otworzył PR | potwierdzone (zero PR autora `app/renovate`); alerty: 1 krytyczny, 7 wysokich, 15 średnich, 4 niskie; PR #365 zamyka 27 z nich |
| `db-backup-skrypt.test.ts` pada na bashu 3.2 | potwierdzone (22 przypadki) |
| `panel-mfa.test.ts` niestabilny (ok. 1/1000) | potwierdzone, dokładnie 1/1024; ta sama pułapka w `middleware-mfa-boundary.test.ts` i (uśpiona) w `passkey-session-marker.test.ts` |
| lint: 30 ostrzeżeń | potwierdzone (0 błędów), 18 s |
| brak workflowów z `schedule` | potwierdzone |
| giganty 2 033 / 1 778 / 1 315 linii | potwierdzone |
| PR #368 zmienia pliki strony głównej | **scalony** (`7a249d3f`), blokada zniknęła |
| świeży worktree: `pnpm install` | 13 s z pamięcią podręczną pnpm; `pnpm typecheck` 14 s na zimno, 3 s na ciepło |
| `vitest related` | 6 s dla `lib/supabase/middleware.ts`, 56 s dla `lib/auth/passkey/session-marker.ts` (165 plików testów) |
| worktree | 58 katalogów, 55 GB |

## 3. Etapy

Koszt utrzymania: N = prawie zero, Ś = do poprawki raz na kwartał,
W = wymaga opieki. „Zawęża?” = czy trafia do kontekstu, który Claude czyta
zawsze.

### Etap 1: szybkie (04.11.2026)

| # | Co | Gdzie | Koszt | Zawęża? |
|---|---|---|---|---|
| 1.1 | Stabilne testy MFA: fałszywy podpis zawsze inny (zmiana pierwszego znaku podpisu) | #370 | N | nie |
| 1.2 | Test `db-backup.sh` pomijany przy bashu < 4 (macOS) | #371 | N | nie |
| 1.3 | `scripts/dev/przygotuj-worktree.sh` + hook SessionStart w `.claude/settings.json` (w gicie) + `.githooks/pre-push` | #372 | N | nie: cisza, gdy gra |
| 1.4 | Renovate bez automatycznego scalania i z 3-dniową kwarantanną nowych wersji | #373 | N | nie |
| 1.5 | Pluginy i MCP: diff `~/.claude/settings.json` | sekcja 5.1, klika Bartosz | N | **zdejmuje** ok. 160 nazw skilli z każdej rozmowy |
| 1.6 | Pamięć: nowy indeks ok. 500 słów, lista plików do usunięcia | sekcja 5.2, decyduje Bartosz | N | **zdejmuje** ok. 850 słów |
| 1.7 | Instalacja Renovate | sekcja 6, klika Bartosz | N | nie |

Hook przed pushem robi: (a) blokadę wartości z `.agents/infra.env` w nowych
liniach (repo publiczne, adresy już raz wyciekły), (b) `pnpm typecheck`,
(c) `eslint` zmienionych plików, (d) `vitest related`. Wartości nie są nigdzie
wypisywane. Pominięcie: `SKIP_PREPUSH=1 git push`.

### Etap 2: rdzeń i strażnicy

| # | Co | Koszt | Zawęża? |
|---|---|---|---|
| 2.1 | `AGENTS.md` do ok. 1 500 słów: zostają projekt, stos, konwencje, niezmienniki bezpieczeństwa i compliance, protokół naprawy, „Co NIE robić”, mapa „co gdzie robisz” z odnośnikami. Wychodzą do runbooków: scalanie PR (`docs/runbooks/scalanie-pr.md`), migracje (`wgrywanie-migracji.md`), wdrożenie i weryfikacja (rozszerzenie `deploy-production.md`), pułapki Coolify (`coolify-pulapki.md`) | Ś | **zdejmuje** ok. 2 800 słów |
| 2.2 | Skille w `.claude/skills/` (w gicie, po kilka linii, odnośnik do runbooka): `/wdrozenie`, `/migracja`, `/naprawa`, `/fa3-ksef`, `/telefon-review`. Operacyjne (`wdrozenie`, `migracja`) z `disable-model-invocation: true`, czyli tylko na polecenie. Opisy wąskie, jedno zdanie | N | lekko: 5 jednozdaniowych opisów |
| 2.3 | `pnpm db:push:prod` kończy się błędem z odnośnikiem do runbooka (dziś pułapka nr 1 w `AGENTS.md`, chroni też Codexa) | N | **zdejmuje** regułę |
| 2.4 | Lint: 30 ostrzeżeń do zera, potem `--max-warnings 0` w CI; `eslint --cache` lokalnie (`.eslintcache` w `.gitignore`) | N | nie |
| 2.5 | Cichy hook PostToolUse po `Edit`/`Write`: eslint na jednym pliku, odzywa się tylko przy błędzie | N | nie |
| 2.6 | Strażnik migracji (test Vitest): numer pliku = wiersz w rejestrze `CLAUDE-DO-CODEXA.md`, numery unikalne, „następny wolny” większy od największego, nagłówek mówi „przed”/„PO wdrożeniu”, `DROP`/`TRUNCATE`/`DELETE FROM` tylko z adnotacją | Ś | **zdejmuje** część reguł z 2.1 |
| 2.7 | Zgodność `types/database.ts` z migracjami: job CI stawia bazę z migracji (jak `rls`), generuje typy i porównuje | Ś | nie |
| 2.8 | Szybsze testy: pomiar importów (69 s z 198 s), potem `--shard` na 3 maszyny w CI; `vitest related` już w hooku 1.3 | Ś | nie |
| 2.9 | Strażnik tekstów na całe UI (`app/`, `components/`, `lib/marketing`, maile): długi myślnik, plakietka nad nagłówkiem, „FaktFlow”. Rozszerza `nazwa-produktu`, nie dubluje | Ś | **zdejmuje** `feedback-teksty-bez-slopu` z pamięci |
| 2.10 | `scripts/ops/scal-zielone.sh`: zbiorcze scalenie gotowych PR wg `AGENTS.md` (gałąź `claude/scalenie-…`, `--no-ff` po kolei, `pnpm run ci && pnpm build`, PR z tabelą). Uruchamia Bartosz albo sesja na jego polecenie | Ś | nie |
| 2.11 | `/code-review` przed każdym PR jako drugi czytelnik (punkt 8 protokołu); w `AGENTS.md` jedna linia | N | jedna linia |
| 2.12 | Wspólne uprawnienia tylko do odczytu w `.claude/settings.json` (`gh pr view`, `git log`, `pnpm vitest`…), mniej pytań o zgodę; reguły `deny` dla `git push --force` | N | nie |

### Etap 3: większe i niezależne (każde osobna sesja z pełnym briefem)

| # | Co | Koszt | Uwagi |
|---|---|---|---|
| 3.1 | Build obrazów `runner` i `worker` w GitHub Actions do GHCR, wdrożenie przez API Coolify (worker, potem aplikacja), kontrola po wdrożeniu, blokada przy niewgranych migracjach. Na start tylko `workflow_dispatch` | W | zmiana w Coolify (źródło obrazu, token API) tylko za zgodą; zdejmuje z `app-1` 12–18 min i 4,5 GB swapu; to też etap 1a planu skalowania |
| 3.2 | Wizualne testy dymne Playwright `toHaveScreenshot`: iPhone 13 (WebKit) i desktop 1440 (Chromium), `reducedMotion: 'reduce'`; strona główna, menu hamburgera, `#telefon`, `/login`, pulpit, lista faktur. Plus `@axe-core/playwright` na tych samych ekranach (pomysł 4.3) | Ś | pilnuje zamrożonego Maca automatem zamiast reguły |
| 3.3 | ~~Raport poranny na Telegram (launchd)~~ **Odrzucone 07.11:** dublowałby raport dzienny o 6:00 (`daily-summary-email`, Telegram) i bramkę `/status` (`ops/bramka`). Zamiast tego raport dzienny dostał kopię, rozmiar bazy i WAL slotu (#434) | N | przeoczenie w analizie 04.11: bramki i raportu dziennego nie było na liście „nie dubluj” |
| 3.4 | Czujka zmian schematu FA(3) MF i cotygodniowy restore-drill z alarmem. Nocny test KSeF TEST robi już #411 Igora (bez sekretów), więc go nie dublujemy | Ś | sesja „Etap 3.4” |
| 3.5 | Błąd krytyczny zakłada issue (deduplikacja po kodzie błędu); Bartosz dodaje `agent:napraw` | Ś | korzysta z `critical-alerts-monitor` i `agent.yml`, nie dubluje |
| 3.6 | Sprzątanie: archiwizacja sesji po scaleniu PR (ustawienie aplikacji, za zgodą), cotygodniowe usuwanie `.next` w worktree bezczynnych > 7 dni (`scripts/dev/sprzataj-worktree.sh`) | N | |
| 3.7 | Później: podział `submit-invoice.ts`, `duplicate-decision.ts`, `invoice-form.tsx` z listą niezmienników spisaną przed zmianą; stopniowe `noUncheckedIndexedAccess` (katalog po katalogu) | W | każdy gigant osobna sesja |

## 4. Pomysły z przeglądu 04.11

| # | Pomysł | Koszt | Zawęża? | Decyzja |
|---|---|---|---|---|
| 4.1 | Blokada adresów z `infra.env` w pre-push (lokalnie, bez publikowania wartości) | N | nie | **zrobione w 1.3** |
| 4.2 | Renovate z `minimumReleaseAge` 3 dni (ochrona przed przejętymi paczkami npm) | N | nie | **w 1.4** |
| 4.3 | `@axe-core/playwright` przy testach wizualnych | N | nie | w 3.2 |
| 4.4 | Knip (nieużywane pliki, eksporty, zależności): najpierw raport tygodniowy, nie blokada | Ś (fałszywe trafienia przy MDX, workerze, skryptach) | nie | etap 2, po 2.4 |
| 4.5 | Budżet First Load JS w jobie `build` (liczba z wyjścia `next build`, próg jako liczba w repo) | N | nie | etap 2; zamyka otwarty wątek „lazy-load PostHog” |
| 4.6 | Cache `.tsbuildinfo` i `.eslintcache` w CI (`actions/cache`) | N | nie | przy 2.8 |
| 4.7 | Subagent `weryfikator` (Opus, tylko odczyt) w `.claude/agents/` | N | lekko | **odrzucone na razie**: `/code-review` robi to samo |
| 4.8 | Styl odpowiedzi „raport” | N | **tak**, ładowany zawsze | **odrzucone**: format raportu jest w protokole |
| 4.9 | Reguły gitleaks dla adresów serwerów | — | — | **odrzucone**: wartości musiałyby być w publicznym repo; 4.1 robi to lokalnie |
| 4.10 | Dependabot obok Renovate | — | — | po instalacji Renovate wyłączyć PR wersji Dependabota (alerty zostają), inaczej podwójne PR |
| 4.11 | `pnpm approve-builds`: `sharp` i `unrs-resolver` celowo w `ignoredBuiltDependencies` | — | — | bez zmian, tylko notatka |

## 5. Do decyzji Bartosza (poza repo)

### 5.1 Pluginy i MCP (`~/.claude/settings.json`)

```diff
   "enabledPlugins": {
-    "gitlab@claude-plugins-official": true,
-    "github@claude-plugins-official": true,
-    "posthog@claude-plugins-official": true,
-    "logo-design@logo-design-skill": true
+    "gitlab@claude-plugins-official": false,
+    "github@claude-plugins-official": false,
+    "posthog@claude-plugins-official": false,
+    "logo-design@logo-design-skill": false
   },
```

- `gitlab`: repo jest na GitHubie.
- `github`: serwer MCP się nie łączy (zły nagłówek autoryzacji), a `gh` działa
  i jest w uprawnieniach.
- `posthog`: ok. 160 nazw skilli w każdej rozmowie. Przy pracy nad analityką
  włącza się go na chwilę.
- `logo-design`: logo jest gotowe (#321).
- Plugin `design` (7 serwerów MCP bez logowania) i `cowork-plugin-management`
  pochodzą z aplikacji Claude, nie z `settings.json`: wyłącza się je
  w aplikacji (Ustawienia → Pluginy).
- W `~/.claude/settings.local.json` jest `Bash(git push:*)` globalnie. Zostaje
  (push jest potrzebny), hook 1.3 jest siatką.

### 5.2 Pamięć

Projekt nowego indeksu i lista plików do usunięcia są poza repo (pamięć jest
prywatna): `side-session-notes/…/pamiec-propozycja.md`. Zrobione 05.11 (dziennik).

### 5.3 Wspólne uprawnienia w `.claude/settings.json` (punkt 2.12)

Klasyfikator trybu auto słusznie nie pozwala sesji samej dopisać sobie reguł
`allow`. Propozycja do zgody Bartosza (tylko odczyt i testy; `deny` blokuje
nadpisanie historii i push prosto na `main`):

```json
"permissions": {
  "allow": [
    "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)",
    "Bash(git branch:*)", "Bash(git fetch:*)", "Bash(git merge-base:*)", "Bash(git rev-parse:*)",
    "Bash(gh pr view:*)", "Bash(gh pr list:*)", "Bash(gh pr checks:*)", "Bash(gh pr diff:*)",
    "Bash(gh issue list:*)", "Bash(gh issue view:*)", "Bash(gh run list:*)", "Bash(gh run view:*)",
    "Bash(pnpm typecheck)", "Bash(pnpm lint:*)", "Bash(pnpm eslint:*)", "Bash(pnpm exec eslint:*)",
    "Bash(pnpm vitest:*)", "Bash(pnpm exec vitest:*)", "Bash(pnpm test)", "Bash(pnpm run ci)",
    "Bash(pnpm build)", "Bash(bash scripts/dev/przygotuj-worktree.sh)"
  ],
  "deny": [
    "Bash(git push --force:*)", "Bash(git push -f:*)", "Bash(git push --force-with-lease:*)",
    "Bash(git push origin main:*)", "Bash(git push origin HEAD:main:*)"
  ]
}
```

Zgoda Bartosza w czacie 07.11.2026 („uprawnienia: tak”); zapisane w `.claude/settings.json`.

08.11.2026 (Bartosz: „zrób wszystkie kroki od A do C”, lista z 08.11, punkt C6):
doszło `Bash(./scripts/ops/kontrola-faktur-ksef.sh)`. Skrypt czyta produkcję,
więc każde jego `psql` ma w `PGOPTIONS` transakcję tylko do odczytu i limit
30 s, a sam plik jest w `CODEOWNERS`; pilnuje tego
`tests/unit/kontrola-skrypt-tylko-odczyt.test.ts`.

## 6. Instalacja Renovate (klika Bartosz, ok. 3 minuty)

Najpierw scal #373 (1.4): obecny `renovate.json` scala sam poprawki (patch)
i próbuje to robić gałęzią prosto do `main`, co łamie zasadę „scala tylko
Bartosz” i i tak nie przejdzie przez ochronę `main`.

1. Otwórz https://github.com/apps/renovate i kliknij **Install** (albo
   **Configure**, jeśli już jest).
2. Wybierz konto `ezior8888-cpu` → **Only select repositories** → `FaktWay` (do 05.11.2026 `ksef-saas`)
   → **Install**.
3. Pierwszy PR to zwykle „Configure Renovate” albo od razu „Dependency
   Dashboard” (issue). Nic nie scalaj w ciemno: `renovate.json` już jest.
4. Sprawdzenie po godzinie: `gh issue list --search "Dependency Dashboard"`
   i `gh pr list --author app/renovate`.
5. Każdy PR Renovate przechodzi 11 kontroli CI jak każdy inny. Limit to
   6 otwartych naraz i 4 na godzinę.

## 7. Dziennik sesji

| Data | Etap | PR | Stan |
|---|---|---|---|
| 04.11.2026 | Analiza, plan, etap 1 (1.1–1.4) | #374 (plan), #370, #371, #372, #373 | PR otwarte, lokalnie `pnpm run ci` zielone na wszystkich pięciu razem; 1.5–1.7 czekają na decyzję Bartosza |
| 05.11.2026 | 1.5 pluginy (zgoda Bartosza) | — | `gitlab`, `github`, `posthog`, `logo-design` wyłączone w `~/.claude/settings.json` (zostają zainstalowane, włącza się je na chwilę); plugin `design` z aplikacji czeka na kliknięcie Bartosza |
| 05.11.2026 | 1.6 pamięć (zgoda Bartosza) | — | `MEMORY.md` 1 387 → 279 słów; 13 plików przeniesionych do `memory-archiwum-2026-11-04/` (obok katalogu pamięci, z kopią starego indeksu); `coolify-operacje.md` zostaje do 2.1 |
| 05.11.2026 | 2.3 `db:push:prod` wyłączony | #376 | z `SUPABASE_DB_URL` skrypt naprawdę wołał `supabase db push` (test czerwony 4/4); `.mjs` i `.sh` kończą się błędem z odnośnikiem |
| 05.11.2026 | 2.6 strażnik migracji | #377 | `tests/unit/migracje-rejestr.test.ts`; repo i otwarte #369, #195, #190 przechodzą |
| 05.11.2026 | 2.1 `AGENTS.md` + runbooki | #378 | 4 379 → 1 953 słów (cel 1 500 nie osiągnięty: konwencje i protokół to niezmienniki); 367 linii procedur dosłownie w 4 runbookach, 0 zgubionych; stos na #374, #372, #376 |
| 05.11.2026 | Scalenie etapu 1 i 2.1/2.3/2.6 (polecenie Bartosza) | #379 | `5e63f1fa`; #370–#374 i #376–#378 oznaczone przez GitHub jako scalone; bez migracji i bez wdrożenia (kod aplikacji bez zmian) |
| 05.11.2026 | 1.7 Renovate zainstalowany (Bartosz, tryb „Scan and Alert”) | — | „Dependency Dashboard” jeszcze nie powstał w chwili wpisu |
| 05.11.2026 | 2.4 lint 30 → 17, próg `--max-warnings 17`, `--cache` | #398 | 17 zostało: ostrzeżenia kompilatora React w komponentach klienta, każde zmienia zachowanie, więc osobny PR z oceną przypadków (2.4b) |
| 05.11.2026 | 2.5 hook lintu po edycji | #399 | ok. 0,5 s, cisza gdy czysto; 2.12 (uprawnienia) czeka na zgodę, sekcja 5.3 |
| 05.11.2026 | Renovate po instalacji | #400 | Dependency Dashboard (#397) i 16 osobnych PR bezpieczeństwa (#381–#396); #400 składa je w jeden; tryb Mend „Scan and Alert” (domyślny „Scan Only” nie otwiera PR) |
| 05.11.2026 | Scalenie #365, #398, #399, #400 (polecenie Bartosza) | #402 | auto-merge metodą merge; wdrożenie (zależności z #365) czeka na polecenie Bartosza |
| 05.11.2026 | 2.2 skille + 2 runbooki | #403 | `/wdrozenie`, `/migracja`, `/naprawa`, `/telefon-review` tylko ręcznie, `/fa3-ksef` także dla modelu; `fa3-ksef.md` i `zmiany-na-telefon.md` przeniesione z prywatnej pamięci Claude, żeby widział je Codex |
| 05.11.2026 | 2.4b lint 17 → 0, `--max-warnings 0` | #404 | 8 poprawek (refy w useLayoutEffect, useSyncExternalStore, useWatch, useMemo, sprzątanie efektu), 7 świadomych wzorców z `eslint-disable-next-line … -- powód`; bez zmian klas |
| 05.11.2026 | Scalenie #403 i #404 (polecenie Bartosza) | #407 | `39e63bfa`; #402 scalony ręcznie `gh pr merge --merge`, bo auto-merge nie ruszył przy zielonym CI; wdrożenie `9f152212` zrobiła sesja „Telefon: design i animacje” na polecenie Bartosza |
| 07.11.2026 | 2.9 strażnik tekstów | #418 | zapadka: 744 „—” w 195 plikach klienta, 0 plakietek; nowe nie wejdą |
| 07.11.2026 | 2.10 `scripts/ops/zloz-scalenie.sh` | #419 | kontrola, gałąź, ci+build, PR zbiorczy; nie scala; pełny przebieg niesprawdzony (założyłby PR) |
| 07.11.2026 | 2.11 drugi czytelnik w protokole | #420 | punkt 6 protokołu w `AGENTS.md`: `/code-review` (Claude) albo osobna sesja (Codex) |
| 07.11.2026 | Scalenie #418–#420 (polecenie Bartosza) | #422 | `bbdf4e2e`; przy składaniu CodeQL zatrzymał #418 (`js/file-system-race` w teście), poprawione; auto-merge zablokowany przez tryb auto, scalił Bartosz |
| 07.11.2026 | 2.7 typy bazy w CI | #423 | job RLS: 1288 pozycji, 0 błędów (brak dryfu produkcji), 13 ostrzeżeń: 00167 bez typów z produkcji i stałe `invoices.ksef_upo_expected` |
| 07.11.2026 | 2.8 Vitest w 3 częściach | #424 | ta sama wymagana kontrola; lokalnie 57/71/83 s zamiast 180 s, suma = pełny zestaw |
| 07.11.2026 | #423 i #424 scalone (polecenie Bartosza) | — | `0dadc429`, `a42d7db0`; CI na `main` ok. 3,5 min zamiast 9 |
| 07.11.2026 | Etap 3: sesje 3.1 i 3.2 | #425, #426, #427 | 3.1 build obrazów w CI (10 kroków Bartosza w opisie #425); 3.2 testy wizualne, przy okazji błąd hydratacji strony głównej przy „ogranicz ruch” (#427) |
| 07.11.2026 | 3.1 build obrazów w Actions, wdrożenie przez API Coolify | #425 | workflow tylko ręczny; blokada migracji przez `/api/ops/deploy-state` (token), Coolify przez Tailscale; nic nie działa przed 10 krokami Bartosza z runbooka `wdrozenie-produkcji.md` (sekrety, zmienne, Tailscale, Coolify z obrazu) |
| 07.11.2026 | 3.2 testy wizualne + 4.3 axe | #426 | `pnpm test:wizualne`: 6 ekranów, iPhone 13 (WebKit) i desktop 1440 (Chromium), 11 wzorców z Maca; 2 przebiegi bez różnic, celowe `gap-1` złapane (1949 i 2300 px); axe: 0 `critical`, `serious` kontrast i `aria-hidden-focus` (raport). Linux/CI niezrobione: rekomendacja kontener `playwright run-server` + konto testowe + `ubuntu-24.04-arm` (3.2b); znalezione: błąd hydratacji strony głównej przy „ogranicz ruch” (`hero-preview.tsx`) |
| 07.11.2026 | 2.12 uprawnienia (zgoda Bartosza), archiwizacja sesji po zamknięciu PR (ustawienie aplikacji, zgoda) | #429 | etap 2 zamknięty |
| 07.11.2026 | 3.5 alarm krytyczny → issue | #432 (scalony w #437) | `lib/alerts/github-issue.ts` po Slacku i Telegramie: jedno issue na kod, komentarz najwyżej co godzinę, 3 nowe na godzinę, treść z listy dozwolonych pól; etykietę `alert-produkcji` założyła sesja, token `GITHUB_ALERT_ISSUES_TOKEN` dodał Bartosz w workerze (07.11); działa od wdrożenia workera |
| 07.11.2026 | 3.6 sprzątanie `.next` | #431 | `scripts/dev/sprzataj-worktree.sh`; podgląd: 18,2 GB w 5 worktree przy progu 0 dni |
| 07.11.2026 | 3.3 w nowej postaci: raport dzienny | #434 | kopia bazy (próg 26 h jak bramka), rozmiar bazy, WAL slotu (próg 2 GB) w raporcie o 6:00 |
| 07.11.2026 | Scalenie #430 i #437, migracje, wdrożenie (polecenie Bartosza) | #430, #437 | `620ee8c8`, `16512d37`; #432 najpierw zamknięty z odnośnikiem (treść w `main`), potem otwarty ponownie i scalony z konta `ezior8888-cpu` (`e68c6653`, tylko 4 linie dziennika); 00167–00169 (księgowość K3–K5) wgrane na db-1 przed wdrożeniem; wdrożenie 21:31: worker `16512d37`, aplikacja `e68c6653` (ten sam kod), 38 min, kontrola czysta (health 200, 31/31 cronów, nic nie utknęło); poprawka `zloz-scalenie.sh` z detached HEAD w #438 |
| 07.11.2026 | Przeoczenie z analizy: `ops/bramka` | — | bramka ma już `/wdroz` z kontrolą CI i niewgranych migracji (funkcje `ops`, 00100); #425 dodał drugi mechanizm migracji (`/api/ops/deploy-state`). Decyzja Bartosza przed krokami 2–9 z #425: workflow przez funkcje `ops` czy nowy endpoint |
| 07.11.2026 | 3.4a czujka schematu FA(3) (test KSeF TEST jest w #411) | #435 | wtorek rano: crd.gov.pl po skrócie (normalizacja `schemaLocation`), `CIRFMF/ksef-docs` po liście i blobach; różnica = issue `czujka-fa3` z diffem nazw, MF niedostępny = ostrzeżenie; na żywo zgodne |
| 07.11.2026 | 3.4b cotygodniowy restore-drill z alarmem | #436 | `restore-drill.sh` z werdyktem (7 przypadków czerwonych na `main`); timer na `db-1` (niedziela 03:30 UTC), osobny check Healthchecks 7 dni + 1 dzień; nic nie zainstalowane: 3 kroki Bartosza w opisie #436. Odczyt `db-1` zablokowany przez tryb auto, pierwsza próba to pokaże. Później: wynik w raporcie dziennym albo `critical-alerts-monitor` (wymaga migracji `backup_kind`), przeniesienie na `ops-1` po Storage Boxie |
| 07.11.2026 | 3.4 scalenie i instalacja (polecenie Bartosza) | #436 (niesie #435) | oba scalone; restore-drill zainstalowany na `db-1` przez Bartosza (`zainstaluj-restore-drill.sh`, tryb auto blokuje zapis na serwerze), pierwsza próba `WYNIK: OK` w 13 s, ping do checku Healthchecks „restore-drill” wysłany; czujka FA(3) po scaleniu ręcznie na GitHubie: „zgodny z repo”, bez issue |
| 08.11.2026 | Lista Bartosza A–C (polecenie „zrób wszystkie kroki”) | #448, #298, scalenie #417 | A1: 00170 i 00171 już na db-1; `kontrola-faktur-ksef.sh` tylko do odczytu (PGOPTIONS, sprawdzone na db-1: `on`, `30s`, przebieg bez błędów) i bez pytania dla agenta; #298 odświeżony na 4096 MB; #417 odświeżony w nowym PR (konflikt rejestru, 4 długie myślniki ze strażnika tekstów); 3.7a przekierowana na `invoice-form.tsx` (`submit-invoice.ts` zmienia 5 PR). Znalezione: bramka `/wdroz` wdraża web przed workerem (`ops/bramka/src/deploy.mjs`), odwrotnie niż `wdroz-produkcje.sh` |

**Następny krok:** Bartosz: decyzja przy #425 (B1 listy z 08.11: wdrożenie
przez nowy endpoint czy przez bramkę `/wdroz`), potem jej kroki; scalenie
odświeżonego #417 (00164 przed wdrożeniem) i #298; sprzątanie worktree
z harmonogramem (najpierw `main` w głównym katalogu); plugin `design`
w aplikacji. Sesja: 3.7c (`invoice-form.tsx`) w toku, 3.7a
(`submit-invoice.ts`) po #417, #195 i #190, 3.7b po decyzji o #336;
osobno kolejność web/worker w bramce `/wdroz`.