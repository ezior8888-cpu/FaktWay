# Wdrożenie produkcji

> Wydzielone z `AGENTS.md` 05.11.2026 (plan usprawnień, 2.1), treść bez zmian.
> Jedną linią: `./scripts/ops/wdroz-produkcje.sh` (worker, potem aplikacja, na końcu kontrola). Niżej kolejność wydania i droga ręczna.
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
