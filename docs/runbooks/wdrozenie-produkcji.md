# Wdrożenie produkcji

> Wydzielone z `AGENTS.md` 05.11.2026 (plan usprawnień, 2.1), treść bez zmian.
> Jedną linią: `./scripts/ops/wdroz-produkcje.sh` (worker, potem aplikacja, na końcu kontrola). Niżej kolejność wydania i droga ręczna.
> Nowa droga (obrazy z GitHub Actions, od 3.1 planu usprawnień): sekcja [„Droga przez GitHub Actions”](#droga-przez-github-actions-obrazy-z-ghcr). Działa dopiero po krokach Bartosza z tej sekcji; do tego czasu obowiązuje stara.
> Adresy: `source .agents/infra.env` (`AGENTS.md`, „Skąd wziąć adresy”).
> Powiązane: [`scalanie-pr.md`](scalanie-pr.md), [`wgrywanie-migracji.md`](wgrywanie-migracji.md), [`wdrozenie-produkcji.md`](wdrozenie-produkcji.md), [`coolify-pulapki.md`](coolify-pulapki.md).

## Kolejność przy pełnym wydaniu

```
0. Bartosz w czacie wprost prosi o scalenie / wdrożenie
1. pnpm run ci && pnpm build        ← lokalnie, PRZED pushem
2. PR do main, 11/11 kontroli CI zielone → scalenie („Scalanie PR”)
3. migracje „przed wdrożeniem” na db-1 (+ schema_migrations + NOTIFY pgrst
   + weryfikacja) — tylko pliki z main
4. wdrożenie: worker id=2, potem aplikacja id=1 — po kolei, nie naraz
5. migracje „PO wdrożeniu” (jeśli nagłówek migracji tak mówi)
6. weryfikacja: kontenery healthy na nowym SHA, /api/health, strona,
   logi bez błędów, w logu workera „29/29 cronów” (liczba z rejestru jobów)
```

`pnpm test` to tylko 3 testy tsx — pełny zestaw (typy, lint, XML, Vitest)
to `pnpm run ci`. `main` jest chroniony, więc `git push origin main` nie
przejdzie: wszystko idzie przez PR. Worker i aplikację budujemy po kolei,
bo oba buildy jadą na `app-1` i razem nie mieszczą się w pamięci.

Krok 1 nie jest zbytkiem: produkcyjny build trwa 12-18 minut, a `pnpm build`
lokalnie łapie w trzy minuty te same błędy (np. plik `'use server'`
eksportujący coś innego niż funkcję asynchroniczną — `pnpm typecheck` tego
NIE łapie).

## Wdrożenie produkcji

Wdrożeniami steruje Coolify na `ops-1`. Najpewniejsza droga to `tinker`,
bo interfejs bywa zawodny.

Kod PHP podajemy na WEJŚCIU, przez heredoc w apostrofach — nie przez
`--execute`:

```bash
ssh -i $K root@$OPS \
  'docker exec -i coolify php artisan tinker' <<'PHP'
$a = App\Models\Application::find(1);
queue_application_deployment(application: $a,
  deployment_uuid: (string) new \Visus\Cuid2\Cuid2(),
  force_rebuild: false, commit: 'HEAD', is_api: false);
PHP
```

Worker jobów to `id=2` — ta sama komenda z `find(2)`. Build trwa 12-18 minut.

**Dlaczego heredoc, a nie `--execute`.** Wariant z `--execute="..."` przechodzi
przez DWA shelle: lokalny i zdalny. `\$a` przeżywa lokalny jako `$a`, a potem
zdalny rozwija je do pustego napisu i do tinkera trafia `= App\Models\...`:

```
PHP Parse error: Syntax error, unexpected '=' on line 1
```

Heredoc w apostrofach (`<<'PHP'`) nie rozwija niczego lokalnie, a apostrofy
wokół komendy zdalnej zamykają sprawę po drugiej stronie. Przy okazji znika
też potrzeba podwajania ukośników w `App\\Models\\` i `\\Visus\\Cuid2`.
`docker exec` musi mieć `-i`, inaczej nie przyjmie wejścia.

Ten sam wzorzec działa do wszystkiego, co robimy tinkerem — na przykład
do sprawdzenia, co jest w kolejce wdrożeń:

```bash
ssh -i $K root@$OPS \
  'docker exec -i coolify php artisan tinker' <<'PHP'
foreach (App\Models\ApplicationDeploymentQueue::orderBy('id','desc')->take(4)->get() as $d) {
  echo $d->id . " | " . $d->application_name . " | " . $d->status . " | " . $d->commit . "\n";
}
PHP
```

**Czytanie wyjścia `tinker`:** odbija on wpisane linie z prefiksem `>` i skraca
długie znakiem `<`. Filtrowanie po początku linii (`grep "^app"`) gubi wynik
i wygląda, jakby wdrożenie nie istniało. Filtruj po treści, nie po `^`.

**Statusy w kolejce:** `queued` → `in_progress` → `finished` albo `failed`.
Build trwa 12-18 minut, więc odpytuj co minutę, a nie w pętli bez przerwy.

## Kiedy wdrożenie padnie

Wyciągnij logi — bez nich zgadujesz:

```bash
ssh -i $K root@$OPS \
  'docker exec -i coolify php artisan tinker' <<'PHP'
$d = App\Models\ApplicationDeploymentQueue::find(NUMER);
$logs = json_decode($d->logs, true) ?? [];
foreach (array_slice(array_map(fn($l) => $l['output'] ?? '', $logs), -40) as $line) {
  echo $line . "\n";
}
PHP
```

Coolify przy nieudanym buildzie **wycofuje nową wersję i zostawia działającą
starą** — awarii produkcji nie ma, masz czas na diagnozę.

## Weryfikacja po wdrożeniu

Nie kończ na „status = finished". Sprawdź, co faktycznie wstało. Komplet
odczytów (kontenery, log workera, statusy faktur, kolejki pg-boss, migracje)
daje jedna komenda, która sama ładuje `infra.env`:

```bash
./scripts/ops/kontrola-faktur-ksef.sh
```

Ręcznie, krok po kroku:

Nazwy kontenerów to hasze generowane przez Coolify i zmieniają się przy
każdym wdrożeniu — nie wpisuj ich z pamięci, wyszukaj:

```bash
K=~/.ssh/hetzner_faktflow_ed25519

# 1. co działa, na jakim commicie, czy healthy
ssh -i $K root@$APP \
  'docker ps --format "{{.Names}}\t{{.Status}}\t{{.Image}}" | grep -v coolify-'

# 2. aplikacja odpowiada (nazwa kontenera znaleziona automatycznie)
ssh -i $K root@$APP 'C=$(docker ps --format "{{.Names}}" \
  | grep "^$APP_PREFIX"); docker exec $C \
  curl -s -o /dev/null -w "app: HTTP %{http_code} w %{time_total}s\n" \
  http://localhost:3000/api/health'

# 3. strona publiczna — apex i www serwują tę samą aplikację wprost,
#    bez przekierowania. Oba rekordy A celują w app-1 w trybie "DNS only",
#    a Coolify ma oba hosty w `fqdn`. Oczekiwane: 200 na obu.
curl -s -L -o /dev/null -w "%{http_code} %{url_effective}\n" https://faktflow.pl

# 4. błędy w logach obu kontenerów
ssh -i $K root@$APP 'for C in $(docker ps --format "{{.Names}}" \
  | grep -E "^$APP_PREFIX|^$WORKER_PREFIX"); do
  echo "--- $C"; docker logs --since 10m $C 2>&1 | grep -i error | head -5; done'
```

Prefiksy nazw: aplikacja `$APP_PREFIX`, worker
`$WORKER_PREFIX` — to identyfikatory aplikacji w Coolify i one
się nie zmieniają, zmienia się tylko sufiks po myślniku.

W logach aplikacji ostrzeżenia `Using the user object as returned from
supabase.auth.getSession()` to znany szum, nie awaria — nie zgłaszaj ich
jako problemu.

## Droga przez GitHub Actions (obrazy z GHCR)

> Plan usprawnień 3.1, etap 1a planu skalowania. Stara droga
> (`scripts/ops/wdroz-produkcje.sh`, build na `app-1`) zostaje, dopóki Bartosz
> nie przełączy Coolify na obrazy (kroki niżej).

### Co robi

Workflow `.github/workflows/obrazy.yml`, uruchamiany ręcznie:

```bash
gh workflow run obrazy.yml -f ref=main -f wdroz=false
```

1. **Build** `runner` i `worker` (cel zawsze jawny) na maszynie GitHuba
   (4 vCPU, 16 GB), z cache warstw w GitHub Actions. Obrazy:
   `ghcr.io/ezior8888-cpu/faktway-runner` i `…-worker`, tag pełnego SHA,
   a przy `ref=main` także `main`. W obrazie jest `APP_COMMIT_SHA`
   (zmienna i etykieta `org.opencontainers.image.revision`).
2. Z `-f wdroz=true` (tylko commit z `main`, środowisko `produkcja`):
   - **blokada migracji**: workflow pyta działającą aplikację
     `GET /api/ops/deploy-state` (token `DEPLOY_STATE_TOKEN`) o wersje
     z `supabase_migrations.schema_migrations` i porównuje je z
     `supabase/migrations` wdrażanego SHA
     (`scripts/ci/migracje-niewgrane.mjs`). Niewgrana migracja „przed
     wdrożeniem” albo bez słowa o kolejności zatrzymuje wdrożenie; te
     z nagłówkiem „PO wdrożeniu” lądują w podsumowaniu jako lista do wgrania
     po. Nagłówek, który wspomina i „PO”, i „przed wdrożeniem”, liczy się
     jako „przed” (w razie wątpliwości blokada). Brak odpowiedzi endpointu
     też zatrzymuje (fail-closed);
   - **worker, potem aplikacja** (`scripts/ci/coolify-wdroz.sh`): tag
     `produkcja` w GHCR przestawiony na SHA, `POST /api/v1/deploy` w Coolify,
     czekanie na `finished` i na `running:healthy`. Przy porażce tag wraca na
     poprzedni obraz, a Coolify zostawia działający stary kontener;
   - **kontrola**: `/api/ops/deploy-state` zwraca nowy SHA, `/api/health`
     200 i `healthy`.
3. Ręcznie dalej: migracje „PO wdrożeniu” z podsumowania
   (`./scripts/ops/wgraj-migracje.sh NNNNN`) i
   `./scripts/ops/kontrola-faktur-ksef.sh`.

**Cofnięcie:** `gh workflow run obrazy.yml -f ref=<poprzedni SHA z main> -f wdroz=true`.
Build trafia w cache, blokada przechodzi (starszy SHA ma mniej migracji).
Uwaga na migracje „PO wdrożeniu” wgrane po nowszym wydaniu: odbierają coś
staremu kodowi, więc przed cofnięciem przeczytaj ich nagłówki.

**Mapy źródeł Sentry** z tego builda będą dopiero, gdy `Dockerfile` przyjmie
`SENTRY_AUTH_TOKEN` jako sekret BuildKitu (szkic #197). Jako zwykły argument
token zostałby w metadanych etapu `build` i w cache, więc workflow go nie podaje.

### Jak workflow dosięga Coolify i bazy (decyzje)

Panel Coolify (`ops-1:8000`) jest za filtrem IP w zaporze Hetznera, a GitHub
nie ma klucza SSH. Rozważone:

| Do czego | Opcja | Ocena |
|---|---|---|
| API Coolify | **Tailscale** (`tailscale/github-action`, węzeł efemeryczny `tag:ci`, ACL tylko do `ops-1:8000`) | **wybrane**: panel zostaje zamknięty dla internetu, zapora bez zmian, bez stałych adresów runnerów; koszt to Tailscale na `ops-1` |
| | panel Coolify pod domeną przez proxy na 443 | odrzucone: logowanie do panelu otwarte na świat; filtr IP nie zadziała dla zmiennych adresów GitHuba |
| | czasowa reguła w zaporze przez API Hetznera | odrzucone: token Hetznera ma władzę nad całym projektem (serwery, dyski) |
| | własny runner na `ops-1` | odrzucone: publiczne repo, kod z PR spoza repo na serwerze produkcji |
| Stan migracji na db-1 | **endpoint w aplikacji** `/api/ops/deploy-state` z tokenem (tylko odczyt, połączenie pg-boss) | **wybrane**: bez nowej sieci i bez nowych ról w bazie; zwraca same numery migracji i SHA; bez tokenu w env trasa nie istnieje (404) |
| | rola tylko do odczytu w Postgresie + dostęp przez tailnet do `db-1` | odrzucone na start: Tailscale także na `db-1`, otwarty port Postgresa w tailnecie |
| | funkcja RPC przez PostgREST | odrzucone: migracja i klucz `service_role` w GitHubie albo odczyt dla `anon` |
| | krok ręczny (zatwierdzenie środowiska) | zostaje jako druga warstwa, ale sam nie sprawdza bazy |

### Kroki Bartosza (poza repo, po kolei)

Nic z tego sesja nie robi sama. Każdy krok da się cofnąć, a do kroku 8 stara
droga działa bez zmian.

1. **Scal PR z 3.1 i wdróż starą drogą** (`./scripts/ops/wdroz-produkcje.sh`).
   Bez migracji. Endpoint `/api/ops/deploy-state` musi działać na produkcji,
   zanim zapyta go blokada.
2. **Token stanu wdrożenia.** `openssl rand -hex 32`. W Coolify, aplikacja
   `id=1`: zmienna `DEPLOY_STATE_TOKEN` (runtime, NIE „Build Variable”;
   wiersz z `is_preview = false`), restart. Ten sam token jako sekret
   `DEPLOY_STATE_TOKEN` środowiska `produkcja` w GitHubie (krok 6).
   Sprawdzenie: `curl -s -H "Authorization: Bearer <token>" https://faktflow.pl/api/ops/deploy-state`
   ma zwrócić `{"commit":null,"migrations":["00001",…]}`. 503 znaczy, że rola
   z `DATABASE_URL` nie czyta `supabase_migrations`: wtedy decyzja
   o `GRANT SELECT` (zmiana w bazie, osobno). Gdy porównanie z repo pokaże
   stare migracje bez wpisu, dopisz je do `schema_migrations` po sprawdzeniu,
   że obiekty istnieją (to naprawa prawdy w bazie, nie wyjątek w kodzie).
3. **Zmienne builda** (GitHub, Settings → Secrets and variables → Actions →
   Variables, poziom repozytorium). Wartości z Coolify, aplikacja `id=1`,
   „Build Variable”, wiersze `is_preview = false`:
   `NEXT_PUBLIC_APP_DOMAIN`, `NEXT_PUBLIC_APP_ENV`, `NEXT_PUBLIC_APP_URL`,
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (wymagane),
   `NEXT_PUBLIC_POSTHOG_HOST`, `NEXT_PUBLIC_POSTHOG_KEY`,
   `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`,
   `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `STRIPE_BLIK_RECURRING` (jeśli jest),
   opcjonalnie `FAKTWAY_URL` (domyślnie `https://faktflow.pl`). To wartości
   jawne (lądują w JavaScripcie strony), więc zmienne, nie sekrety. Na
   przykład: `gh variable set NEXT_PUBLIC_APP_URL --body 'https://…'`.
4. **Pierwszy build bez wdrożenia:**
   `gh workflow run obrazy.yml -f ref=main -f wdroz=false`. Potem w GitHubie
   (profil → Packages) sprawdź, że `faktway-runner` i `faktway-worker` są
   podpięte do repo. **Decyzja 08.11.2026 (Bartosz, delegowana): pakiety
   zostają publiczne.** Repo jest publiczne, a obraz ma tylko kod z repo
   i jawne `NEXT_PUBLIC_*` (build w Actions nie dostaje sekretów ani tokenu
   Sentry), więc prywatność nic nie chroni, a dokłada token na `app-1`
   (krok 7). Pierwszy build: 08.11, run 42477139056, oba obrazy zbudowane.
5. **Tailscale.** Konto (darmowy plan), na `ops-1`:
   `curl -fsSL https://tailscale.com/install.sh | sh && tailscale up`.
   W ACL: `"tagOwners": {"tag:ci": ["autogroup:admin"]}` i reguła dostępu
   tylko `tag:ci` → `ops-1:8000`. Klient OAuth z prawem zapisu kluczy
   (`auth_keys`) i tagiem `tag:ci`: sekrety `TS_OAUTH_CLIENT_ID`,
   `TS_OAUTH_SECRET`.
6. **Środowisko `produkcja`** (GitHub, Settings → Environments): wymagany
   zatwierdzający Bartosz, gałąź `main`. Sekrety środowiska:
   `DEPLOY_STATE_TOKEN` (krok 2), `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`
   (krok 5), `COOLIFY_URL` (`http://<adres ops-1 w tailnecie>:8000`),
   `COOLIFY_TOKEN` (Coolify → Keys & Tokens, uprawnienia `read` i `deploy`,
   API włączone w ustawieniach), `COOLIFY_APP_UUID`, `COOLIFY_WORKER_UUID`
   (krok 8). Adresy i UUID tylko w sekretach: repo jest publiczne.
7. **Pobieranie z GHCR na `app-1`** (przy publicznych pakietach zbędne, zob.
   krok 4): token klasyczny GitHuba tylko
   z `read:packages`, na serwerze `docker login ghcr.io -u ezior8888-cpu`
   jako root (Coolify pobiera obrazy przez Dockera hosta).
8. **Coolify z obrazu.** Jeśli Coolify pozwala zmienić źródło istniejącej
   aplikacji na „Docker Image”, zmień je (UUID, zmienne i domeny zostają).
   Jeśli nie: dwa nowe zasoby „Docker Image”,
   `ghcr.io/ezior8888-cpu/faktway-worker:produkcja` i
   `…-runner:produkcja`, z kopią zmiennych runtime (`is_preview = false`),
   healthcheckiem (`/api/health`, port 3000 dla aplikacji; worker ma
   HEALTHCHECK w obrazie) i, tylko dla aplikacji, domenami przeniesionymi ze
   starej (najpierw zdjąć je ze starej). Stary worker zatrzymaj przed
   pierwszym wdrożeniem nowego. Nowe UUID wpisz do sekretów (krok 6)
   i do `.agents/infra.env` (`APP_PREFIX`, `WORKER_PREFIX`), bo czyta je
   `kontrola-faktur-ksef.sh`. Po przełączeniu `wdroz-produkcje.sh` (`id=1`,
   `id=2`) wdraża stare, zatrzymane aplikacje: droga awaryjna to ich
   ponowne uruchomienie, a skrypt dostanie nowe id w osobnym PR.
9. **Pierwsze wdrożenie:** `gh workflow run obrazy.yml -f ref=main -f wdroz=true`,
   zatwierdzenie w GitHubie, potem `./scripts/ops/kontrola-faktur-ksef.sh`.
10. **Później (osobne PR):** wyzwalacz po scaleniu do `main` (sam build albo
    build i wdrożenie), sekret Sentry przez BuildKit (#197), nowe id
    w `wdroz-produkcje.sh`, zdjęcie 8 GB swapu z `app-1` dopiero po kilku
    wdrożeniach z obrazu.
