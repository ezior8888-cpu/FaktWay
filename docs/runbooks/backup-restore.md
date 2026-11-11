# Kopie bazy i odtwarzanie

Stan po kroku 6 planu automatyzacji (1 października 2026). Decyzja
i uzasadnienie: [ADR-0009](../adr/0009-pg-dump-na-db-1-i-storage-box.md).
Poprzednia wersja tego runbooka opisywała Supabase Cloud i PITR. Jest
w historii gita, ale nie ma już zastosowania.

Komendy zakładają `source .agents/infra.env` (`$K`, `$DB`, `$OPS`, `$PGC`).

## 1. Warstwy kopii

| Warstwa | Co obejmuje | Gdzie | Kiedy | Retencja | Stan |
|---|---|---|---|---|---|
| **A. `pg_dump`** (główna) | cała baza `postgres`: `public`, `auth`, `storage`, `pgboss`, `supabase_migrations` + role | `db-1`, `/root/backups/daily` | cron 01:30 UTC | 14 ostatnich kompletnych (`KEEP`); 2–3 dopiero po uruchomieniu B (§ 3, krok 4) | skrypt gotowy (`scripts/hetzner/db-backup.sh`), instalacja: § 2 |
| **B. Storage Box** | zrzuty z A, zaszyfrowane (`rclone crypt`) | Hetzner Storage Box | po każdym zrzucie A | skrypt usuwa kopie starsze niż 60 dni (`REMOTE_RETENTION_DAYS`) + snapshoty Storage Boxa | **czeka na zakup** (§ 3) |
| **C. Snapshot JSON** (pomocniczy) | tabele `public` przez REST, bez `auth` | MinIO na `ops-1`, `backups/` | 02:00 PL | 30 dni / 8 tyg., zawsze ≥ 7 udanych | działa; alarm, gdy najnowszy > 26 h |
| **D. Backup Hetznera** | obraz dysku `db-1` | Hetzner Cloud | dzienny | 7 | **do sprawdzenia w konsoli** (Servers → db-1 → Backups) |

Pliki faktur (XML FA(3), UPO, PDF) leżą w MinIO na `ops-1` (bucket z
`R2_BUCKET_NAME`), a nie w bazie. Na 1 października 2026 bucket zawiera tylko
snapshoty JSON. Kopia plików na Storage Box: § 3, krok 6.

## 2. Instalacja nocnego zrzutu na `db-1` (raz)

```bash
source .agents/infra.env
scp -i $K scripts/hetzner/db-backup.sh root@$DB:/usr/local/sbin/faktflow-db-backup
ssh -i $K root@$DB "chmod 700 /usr/local/sbin/faktflow-db-backup && umask 077 && \
  printf 'PGC=%s\nBACKUP_DIR=/root/backups/daily\nKEEP=14\n' '$PGC' > /etc/faktflow-backup.env && \
  echo '30 1 * * * root /usr/local/sbin/faktflow-db-backup >> /var/log/faktflow-db-backup.log 2>&1' \
    > /etc/cron.d/faktflow-db-backup && \
  /usr/local/sbin/faktflow-db-backup && ls -la /root/backups/daily"
```

Healthchecks: osobny check „db-backup” (okres 1 dzień, karencja 2 h). Jego
adres dopisz jako `HC_URL=` do `/etc/faktflow-backup.env`. Bez tego cichą
awarię crona złapie tylko ręczne zajrzenie do logu (skrypt pisze tam wtedy
`UWAGA: brak HC_URL`).

**Miejsce na dysku.** Zrzuty leżą na tym samym dysku co dane Postgresa.
Przed zrzutem skrypt sprawdza, czy wolne wynosi co najmniej 2 × ostatni
zrzut (najmniej 1 GB) + 10% systemu plików. Jeśli nie, kończy się błędem
`za mało miejsca` i pingiem `/fail`, a zrzutu nie zaczyna. Wtedy zwolnij
miejsce na `db-1`. Zrzuty na osobnym wolumenie: `DISK_RESERVE_PCT=0`.
Przerwany przebieg sam usuwa swoje pliki `.partial-*`.

**Nazwa kontenera Postgresa zmienia się przy przebudowie usługi w Coolify.**
Po takiej zmianie popraw `PGC` w `/etc/faktflow-backup.env`. Zrzut padnie
wtedy z błędem i pingiem `/fail`, więc nie przejdzie po cichu.

## 3. Kopia poza serwerem — Storage Box (Bartosz)

1. Hetzner Console → Storage Boxes → **BX11**. Włącz: *SSH support*,
   *External reachability*, **automatyczne snapshoty** (np. codziennie,
   14 sztuk). Snapshoty chronią przed skasowaniem plików kluczem z `db-1`.
2. Na `db-1`: `apt install -y rclone`, osobny klucz
   `ssh-keygen -t ed25519 -f /root/.ssh/storagebox -N ''`, a potem
   `cat /root/.ssh/storagebox.pub | ssh -p 23 uXXXXX@uXXXXX.your-storagebox.de install-ssh-key`.
3. `rclone config` na `db-1`:
   - `box` — typ `sftp`, host `uXXXXX.your-storagebox.de`, port `23`,
     user `uXXXXX`, `key_file = /root/.ssh/storagebox`;
   - `boxcrypt` — typ `crypt`, `remote = box:faktflow`, wygenerowane hasło
     i sól.

   **Hasło i sól z `boxcrypt` zapisz w menedżerze haseł.** Bez nich kopii
   na Storage Box nie da się odszyfrować, a utrata `db-1` zabiera też
   `rclone.conf`.
4. Dopisz `RCLONE_REMOTE=boxcrypt:db` do `/etc/faktflow-backup.env`.
   Uruchom `/usr/local/sbin/faktflow-db-backup` i sprawdź
   `rclone ls boxcrypt:db`. Skrypt sam robi `rclone cryptcheck`, potem
   usuwa tam kopie starsze niż 60 dni (umowa powierzenia § 9: cykl ≤ 60 dni)
   i daje `/fail`, gdy Storage Box jest zajęty w ponad 80%. Snapshot z kroku 1
   trzyma też pliki, które skrypt już usunął, więc kopia żyje
   `REMOTE_RETENTION_DAYS` + tyle dni, ile sięgają snapshoty. Umowa
   dopuszcza razem 60 dni: ustaw `REMOTE_RETENTION_DAYS` = 60 − liczba
   dni snapshotów (przy 14 dziennych: 46). W logu co noc
   powinna być linia `Storage Box: zajęte …`. Jeśli jest
   `UWAGA: rclone about nie podał zajętości`, pilnuj zajętości ręcznie.

   **Kiedy obniżyć `KEEP`.** Po tygodniu nocy z `kopia poza serwerem`
   w logu, bez błędu `cryptcheck`, i z włączonymi snapshotami (krok 1)
   można ustawić `KEEP=3`. Decyzja Bartosza. Wcześniej lokalne zrzuty są
   jedyną historią bazy.
5. Odczyt z innej maszyny: zainstaluj `rclone`, skonfiguruj `box` i
   `boxcrypt` tym samym hasłem i solą, a potem
   `rclone copy boxcrypt:db/<nazwa> .`. Przećwicz to raz od razu po
   konfiguracji.
6. Pliki z MinIO (gdy pojawią się faktury klientów): na `ops-1` ten sam
   `boxcrypt` (inny katalog, np. `boxcrypt:files`) i cron
   `rclone copy minio:<bucket> boxcrypt:files`. Zawsze `copy`, nie `sync`.

Koszt: ~4–5 €/mies. (ceny Hetznera sprawdzaj na bieżąco).

## 4. Odtwarzanie

Procedura sprawdzona próbą z 1 października 2026 (§ 5). Scenariusz: `db-1`
stracony albo baza uszkodzona.

**Czego zrzut NIE obejmuje** — przygotuj to osobno, zanim zaczniesz:

| Brakuje | Gdzie jest dziś | Bez tego |
|---|---|---|
| Hasła i klucze usług: `SERVICE_PASSWORD_POSTGRES`, sekret JWT Supabase, klucze `anon`/`service_role`, zmienne aplikacji | wyłącznie baza Coolify na `ops-1` (Coolify nie ma skonfigurowanej żadnej kopii, brak magazynu S3) | nowa usługa Supabase wystawi nowe klucze, a aplikacja przestanie się logować do bazy |
| Pliki faktur (XML, UPO, PDF) | MinIO na `ops-1` | dokumenty trzeba pobrać ponownie z KSeF |
| Klucz `pgsodium` (sekrety `vault`) | wolumen Postgresa na `db-1` | dziś bez znaczenia: `vault.secrets` jest puste |

1. **Zatrzymaj aplikację i workera** (Coolify: id=1, id=2), żeby nic nie pisało
   w trakcie.
2. **Postgres z tym samym obrazem** co produkcja (`supabase/postgres:15.8.1.085`).
   Najlepiej odtworzona usługa Supabase w Coolify z **dotychczasowymi**
   zmiennymi (hasło Postgresa, sekret JWT). Inaczej hasła ról z kroku 4
   rozjadą się z konfiguracją usług.
3. **Zrzut**: najnowszy z `/root/backups/daily` albo z Storage Box
   (`rclone copy boxcrypt:db/<nazwa> .`). Sprawdź `sha256sum -c <nazwa>.sha256`.
4. **Role** (z hasłami produkcyjnymi):
   `psql -U supabase_admin -d postgres -f <nazwa>.roles.sql`.
   Oczekiwane: 12 błędów `role "…" already exists`. Uwaga: plik zmienia też
   hasło `supabase_admin` na produkcyjne.
5. **Dane**:
   ```bash
   pg_restore -U supabase_admin -d postgres --clean --if-exists --no-comments <nazwa>.dump
   ```
   Oczekiwane dokładnie 4 błędy (obiekty, które świeży obraz już ma):
   - `schema "storage" already exists`
   - `cannot drop schema storage because other objects depend on it`
   - `cannot drop constraint users_pkey on table auth.users …`
   - `function graphql_public.graphql(text, text, jsonb, jsonb) does not exist`

   Każdy inny błąd: zatrzymaj się i zbadaj, zanim wpuścisz ruch.
6. **Sprawdź**: liczby wierszy (zapytanie w § 5), ostatnią migrację
   (`SELECT max(version) FROM supabase_migrations.schema_migrations`) i liczbę
   polityk RLS (`SELECT count(*) FROM pg_policies`).
7. **Zadania pg-boss przed startem workera** — zrzut zawiera zlecenia z chwili
   zrzutu i zostaną wykonane ponownie:
   ```sql
   SELECT name, state, count(*) FROM pgboss.job
    WHERE state IN ('created','retry','active') GROUP BY 1, 2 ORDER BY 1;
   ```
   Wysyłki do KSeF chroni uzgadnianie po numerach referencyjnych (krok 4,
   `ksef_submissions`). Maile mogą wyjść drugi raz — zdecyduj, czy je usunąć.
8. `NOTIFY pgrst, 'reload schema';`, restart usług Supabase (auth, rest,
   storage, realtime), potem start workera i aplikacji.
9. Weryfikacja jak po wdrożeniu (`AGENTS.md`): `/api/health`, logowanie,
   lista faktur, logi bez błędów. Wpisz przebieg do protokołu w § 5.

RPO: do 24 h (zrzut raz na dobę). Czas samej bazy w próbie: 16 s. Realne RTO
wyznacza postawienie usług i sekrety z tabeli wyżej, nie wgranie danych.

## 5. Próba odtworzenia (co miesiąc)

Cel: dowód, że zrzut da się wgrać na **innym** hoście niż `db-1`, do
obrazu identycznego z produkcją, z kompletem danych. Raz w miesiącu, ~15 min.

```bash
source .agents/infra.env
D=drill-$(date +%F)
COUNTS="SELECT table_schema||'.'||table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema IN ('public','auth','storage','pgboss','supabase_migrations','vault') ORDER BY 1;"

# 1. zrzut + liczby wierszy z produkcji w tej samej chwili (db-1)
ssh -i $K root@$DB "umask 077; docker exec $PGC pg_dump -U supabase_admin -d postgres -Fc -Z 6 > /root/backups/$D.dump && \
  docker exec $PGC pg_dumpall -U supabase_admin --roles-only > /root/backups/$D-roles.sql && \
  docker exec $PGC psql -U supabase_admin -d postgres -At -F'|' -c \"$COUNTS\" > /root/backups/$D-counts.txt"

# 2. przeniesienie na ops-1 strumieniem (nic nie zostaje na laptopie)
ssh -i $K root@$OPS 'umask 077; mkdir -p /root/drill'
for f in $D.dump $D-roles.sql $D-counts.txt; do
  ssh -i $K root@$DB "cat /root/backups/$f" | ssh -i $K root@$OPS "umask 077; cat > /root/drill/$f"
done
scp -i $K scripts/hetzner/restore-drill.sh root@$OPS:/root/drill/

# 3. próba (kontener bez sieci, usuwany po próbie) i sprzątanie
ssh -i $K root@$OPS "cd /root/drill && bash restore-drill.sh $D.dump $D-roles.sql $D-counts.txt; rm -rf /root/drill"
ssh -i $K root@$DB "rm -f /root/backups/$D.dump /root/backups/$D-roles.sql /root/backups/$D-counts.txt"
```

Po zainstalowaniu Storage Boxa krok 1 zastępuje pobranie najnowszego zrzutu
z `boxcrypt:db` (to sprawdza też hasło `crypt` z menedżera haseł).

Wynik jest poprawny, gdy:
- wszystkie tabele mają liczby wierszy zgodne z produkcją (wyjątek: tabele,
  które rosną same między zrzutem a liczeniem, np. `pgboss.job`);
- jest dokładnie 4 błędy `pg_restore` z listy w § 4;
- liczby polityk, funkcji i indeksów są takie same jak na produkcji.

Obraz `supabase/postgres:15.8.1.085` zostaje na `ops-1` (3 GB) do następnej
próby. Usunięcie: `docker rmi supabase/postgres:15.8.1.085`.

### Cotygodniowa próba na `db-1` (automat)

Od planu usprawnień 3.4 próba chodzi też sama: timer systemd
`faktflow-restore-drill.timer` na `db-1`, niedziela 03:30 UTC
(`scripts/hetzner/systemd/`). Uruchamia
`scripts/hetzner/restore-drill-tydzien.sh`, który:

1. bierze najnowszy **kompletny** zrzut z `BACKUP_DIR` (z plikiem `.sha256`)
   i sprawdza sumy;
2. sprawdza miejsce (odtworzona baza leży na dysku produkcji): co najmniej
   max(2 GiB, 10 × zrzut) + 10% systemu plików;
3. wgrywa go `restore-drill.sh` do kontenera bez sieci z **obrazem
   odczytanym z kontenera produkcji** (`PGC`), więc po aktualizacji
   Postgresa próba idzie na nowym obrazie;
4. pinguje osobny check Healthchecks „restore-drill” (`DRILL_HC_URL`
   w `/etc/faktflow-restore-drill.env`): `/start`, potem sukces albo `/fail`
   z linią `WYNIK:`. Okres 7 dni, karencja 1 dzień: próba, która się nie
   uruchomi, daje alarm po 8 dniach. Alarm idzie integracjami tego checka.

Werdykt `restore-drill.sh` (kod 1 i `WYNIK: BŁĄD`): błąd `pg_restore` spoza
4 oczekiwanych z § 4, błąd pliku ról inny niż „already exists”, tabela ze
spisu zrzutu, która nie powstała, pusta `auth.users` albo `public.tenants`,
brak polityk RLS albo wpisu w `schema_migrations`. Bez liczb z produkcji
różnic wierszy próba nie widzi; to zostaje w próbie comiesięcznej wyżej.

Ta próba nie dowodzi, że kopia przeżyje utratę `db-1` (zrzut i próba są na
tym samym hoście). Po skonfigurowaniu Storage Boxa (§ 3) można ją przenieść
na `ops-1` ze zrzutem z `boxcrypt:db`.

| Chcesz… | Polecenie (z katalogu repo) |
|---|---|
| zainstalować i od razu zrobić pierwszą próbę | `./scripts/ops/zainstaluj-restore-drill.sh` |
| zobaczyć stan (tylko odczyt) | `./scripts/ops/zainstaluj-restore-drill.sh --sprawdz` |
| usunąć | `./scripts/ops/zainstaluj-restore-drill.sh --odinstaluj` |
| log ostatniej próby na `db-1` | `journalctl -u faktflow-restore-drill -n 80 -o cat` |

Alarm „restore-drill” w Healthchecks:

- `/fail` z `sumy kontrolne` albo `brak kompletnego zrzutu`: najpierw check
  „db-backup” i `/var/log/faktflow-db-backup.log`;
- `za mało miejsca`: dysk `db-1` (`./scripts/ops/pojemnosc-db.sh`);
- `nie odczytałem obrazu kontenera`: po przebudowie w Coolify popraw `PGC`
  w `/etc/faktflow-backup.env` (zrzut padnie z tego samego powodu);
- `WYNIK: BŁĄD`: log z `journalctl`; nowy rodzaj błędu `pg_restore` po
  aktualizacji obrazu sprawdź ręcznie jak w § 4, krok 5, i dopiero wtedy
  dopisz go do `EXPECTED_RESTORE_ERRORS` w `restore-drill.sh`;
- `nocny zrzut trwa ponad godzinę`: `/var/log/faktflow-db-backup.log`;
- kontener `faktflow-restore-drill` po przerwanej próbie usuwa następna próba
  i `ExecStopPost` usługi; ręcznie: `docker rm -f faktflow-restore-drill`;
- brak pinga 8 dni: `systemctl list-timers faktflow-restore-drill.timer`,
  `systemctl status faktflow-restore-drill`.

### Protokół prób

| Data | Zrzut | Host | Start / wgranie / razem | Tabele i wiersze | Struktura | Błędy | Wynik |
|---|---|---|---|---|---|---|---|
| 2026-10-01 | 3,4 MB, 1762 pozycje spisu, migracja 00099 | `ops-1`, kontener bez sieci, 1 CPU / 1 GB | 10 s / 6 s / 16 s | 111 tabel, wszystkie liczby zgodne z produkcją | 71 polityk RLS, 67 tabel z RLS, 111 funkcji `public`, 45 wyzwalaczy, 248 indeksów, 9 rozszerzeń — jak produkcja | 4 oczekiwane (§ 4); role: 12× `already exists` | ✅ |
| 2026-11-07 | `faktflow-20261107T013002Z` (nocny), migracja 00200 | `db-1`, automat tygodniowy (pierwszy przebieg przy instalacji), kontener bez sieci, 1 CPU / 1 GB | 7 s / 5 s / 13 s | 122 tabele, wszystkie ze spisu zrzutu; liczby wierszy bez porównania z produkcją | 89 polityk RLS, 78 tabel z RLS, 182 funkcje `public`, 72 wyzwalacze, 288 indeksów, 9 rozszerzeń | 4 oczekiwane (§ 4); role: 12× `already exists` | ✅ |

Wnioski z pierwszej próby, już wbudowane w skrypt: świeży obraz wymaga hasła
także na lokalnym gnieździe (produkcja nie), a plik ról podmienia hasło
`supabase_admin` — w próbie role idą bez haseł.

## 6. Snapshot JSON (warstwa C)

Tworzy go `lib/jobs/runners/daily-db-snapshot.ts`, a sprawdza
`verify-backup.ts` (co tydzień: sumy, odczyt, odchylenie liczby wierszy).
`critical-alerts-monitor.ts` co 5 minut sprawdza świeżość: alarm na Slacku
i w Telegramie, gdy najnowsza udana kopia ma ponad 26 h. Przypomnienie
przychodzi co 6 h.

Lista kopii:

```sql
SELECT id, kind, status, size_bytes, r2_key, started_at
  FROM public.backup_log ORDER BY started_at DESC LIMIT 10;
```

Ta warstwa nie zawiera kont użytkowników (`auth.*`), więc nie nadaje się do
odtworzenia całej aplikacji. Przydaje się do odzyskania pojedynczych wierszy
`public` sprzed wielu dni (retencja 30 dni / 8 tygodni).

### Jak kopia czyta bazę i jak wygląda plik

Od sesji 12 planu skalowania (JOB-02, QAL-01, CPU-03, CPU-V2):

| Co | Jak |
|---|---|
| Odczyt tabeli | stronami po 500 wierszy, po kluczu (`id` albo klucz główny z `SNAPSHOT_KEYS` w `lib/backup/snapshot-tables.ts`), od ostatniego klucza poprzedniej strony. Nowy wiersz dopisany w trakcie nie przesuwa stron, więc nic się nie gubi ani nie dubluje. |
| Plik | dalej jeden JSON (`{"version":1,…,"tables":{…},"row_counts":{…}}`), ale każdy wiersz tabeli w osobnej linii (`"layout":"line-per-row"`). Starsze kopie są jednoliniowe. |
| Zapis | pakowany w locie (`gzip` strumieniem). Spakowany plik czeka w pamięci workera na jedno wgranie do MinIO. |
| Weryfikacja | czyta plik strumieniem i parsuje linia po linii. Linia ponad 64 MiB jest liczona bez parsowania (ostrzeżenie `row_not_parsed`). Stara kopia jednoliniowa ponad 64 MiB ma sprawdzaną tylko sumę kontrolną (`legacy_snapshot_not_parsed`); takie kopie znikną same po 8 tygodniach. Komunikaty błędów nie zawierają treści wierszy. |

Jeden wiersz z pliku:

```bash
gunzip -c 11-010000.json.gz | grep -n '"id":"<uuid>"'
```

**Błąd `dump_table_failed: <tabela>: brak kolumny klucza kopii`.** Tabela
nie ma kolumny `id`. Dopisz ją do `SNAPSHOT_KEYS` z jej kluczem głównym (albo
do `SKIP_TABLES`, jeśli kopia jej nie potrzebuje). Strażnik
`tests/unit/backup-readable-tables.test.ts` łapie takie tabele z migracji
w CI; ten błąd zobaczysz tylko dla tabeli założonej poza migracjami.

### Alarm „Kopia JSON bazy niepełna”

Kopia przekroczyła `MAX_SNAPSHOT_JSON_BYTES` (512 MB JSON-a przed spakowaniem,
`lib/backup/snapshot-tables.ts`). Wtedy przerywa czytanie, nie wgrywa pliku,
zapisuje w `backup_log` status `failed` z komunikatem `kopia_niepelna: …`
i kończy job bez ponowień. Alarm przychodzi raz na dzień (klucz w Redisie
`alerts:backup:json-incomplete:<data UTC>`); po 26 h dołączy do niego alarm
świeżości, bo nie ma nowej udanej kopii. Warstwa A (`pg_dump`) działa osobno
i ten próg jej nie dotyczy.

Co zrobić, po kolei:

1. Sprawdź, że warstwa A ma świeży zrzut (§ 2, § 5). Jeśli tak, nic nie jest
   pilne: tracisz tylko szybkie odzyskiwanie pojedynczych wierszy.
2. Rozmiar JSON-a w ostatnich udanych kopiach widać w alarmie „DB snapshot
   zakończony” na kanale metryk (`json_mb`).
3. Wybierz jedno: podnieś próg (PR, potem wdrożenie workera; spakowany plik
   to zwykle kilka do kilkunastu procent JSON-a, tyle dochodzi do pamięci
   workera), przenieś duże tabele, które ma warstwa A, do `SKIP_TABLES`, albo
   zamów zmianę na wgrywanie w częściach (multipart), żeby plik nie czekał
   w pamięci.
