# Pułapki infrastruktury (Coolify, build, panel)

> Wydzielone z `AGENTS.md` 05.11.2026 (plan usprawnień, 2.1), treść bez zmian.
> Każda kosztowała nas awarię. Czytaj przed zmianą `Dockerfile`, Coolify, zmiennych albo serwerów.
> Adresy: `source .agents/infra.env` (`AGENTS.md`, „Skąd wziąć adresy”).
> Powiązane: [`scalanie-pr.md`](scalanie-pr.md), [`wgrywanie-migracji.md`](wgrywanie-migracji.md), [`wdrozenie-produkcji.md`](wdrozenie-produkcji.md), [`coolify-pulapki.md`](coolify-pulapki.md).

## Pułapki, które kosztowały nas awarie

- **Pusty `dockerfile_target_build` w Coolify** buduje OSTATNI etap pliku.
  Dopisanie etapu na końcu `Dockerfile` raz wyłączyło produkcję na 15 godzin.
  Aplikacja ma jawnie `runner`, worker `worker`.
- **Healthcheck Coolify wymaga `curl` w obrazie.** Bez niego deploy kończy się
  statusem „unhealthy" i wycofaniem, mimo poprawnie działającego procesu.
- **Zmienne środowiskowe mają bliźniaki `is_preview`.** Wyglądają jak duplikaty,
  ale nimi nie są. Produkcja używa `is_preview = false`.
- **`proxy.ts` przepuszcza tylko wymienione rozszerzenia.** Czego nie ma we
  wzorcu, leci przez bramkę auth i kończy przekierowaniem na `/login`.
  Dla wideo objawia się to wyłącznie cichym błędem dekodera.
- **Lokalny `.env.local` celuje w lokalną bazę** (`http://127.0.0.1:54321`),
  nie w produkcję. To celowe. Od 23.10.2026 to Supabase w Dockerze (Colima)
  z migracjami z repo: `pnpm db:local` stawia ją, wgrywa brakujące migracje,
  zakłada konto `dev@faktway.test` (hasło w `scripts/dev/baza-lokalna.sh`)
  i ustawia `.env.local` — także w worktree. Dawny projekt Supabase Cloud
  (`$LOCAL_SUPABASE_REF`) wygasł; nie wracaj do niego i nie celuj devem w db-1.
- **Build padający z `exit code 137` to zabójca OOM, nie błąd kodu.** `pnpm build`
  na `app-1` potrzebuje więcej pamięci, niż maszyna ma fizycznie: pułap sterty
  w `Dockerfile` to 5120 MB (od 11.11.2026; wcześniej 4096), a realnie wolne jest ~2.2 GB (sam `dockerd` bierze
  ~775 MB). Build jedzie na swapie i przy udanym przebiegu zjada go **4.5 GB**.
  Przy 5120 MB build na `app-1` zużyje więcej swapu, więc przed wdrożeniem trzeba
  sprawdzić `swapon --show` (zalecane co najmniej 10 GB) albo budować drogą
  GitHub Actions.
  **`app-1` musi mieć ≥ 8 GB swapu** — przy 4 GB wdrożenie ginie. Sprawdzenie:

  ```bash
  ssh -i $K root@$APP 'swapon --show'
  ```

  Potwierdzenie diagnozy w logach jądra `app-1`:
  `dmesg -T | grep -i oom-kill`. Zdarzyło się 29 sierpnia 2026, gdy urósł
  `lib/flo/`; wcześniej build po prostu nie dobijał do sufitu.
- **Panel Coolify ma filtr po IP w chmurowej zaporze Hetznera, nie na serwerze.**
  Objaw jest mylący: przeglądarka ładuje się w nieskończoność, bo Hetzner
  odrzuca pakiety po cichu, zamiast zamknąć połączenie. Na serwerze `ufw` jest
  wyłączony i `iptables` nic nie blokuje, więc szukanie tam to strata czasu.
  Zamiast dopisywać zmienny domowy adres do zapory — tunel:

  ```bash
  ssh -i $K -N -L 8000:localhost:8000 root@$OPS
  ```

  Potem `http://localhost:8000`. Działa, bo `APP_URL` Coolify jest puste
  i panel trzyma się nagłówka `Host`.
