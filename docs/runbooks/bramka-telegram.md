# Bramka w Telegramie (B-2)

Krok 9 planu automatyzacji (1 października 2026). Bot dla operatorów, który
zastępuje ręczny `tinker` przy wdrożeniach i daje szybki podgląd produkcji.
Kod: `ops/bramka/`, baza: migracja `00100_ops_gate.sql`.

## 1. Co umie

| Polecenie | Co robi | Zabezpieczenie |
|---|---|---|
| `/status` | web i worker w Coolify, heartbeat workera, KSeF, wiek kopii, aktywne wyłączniki, ostatnia migracja | tylko odczyt |
| `/kolejki` | zaległości pg-boss (czeka / w toku / błędy 24 h), faktury utknięte w wysyłce, wstrzymane, Offline24 | tylko odczyt |
| `/wylacz ksef \| flo \| rejestracja` | natychmiast ustawia flagę „kill” | bez TOTP, bo to kierunek bezpieczny; powiadamia pozostałe osoby; wpis w `audit_logs` |
| `/wdroz` | pokazuje commit do wdrożenia, CI, listę zmian i blokady | tylko odczyt |
| `/wdroz <8 znaków SHA> <kod TOTP>` | wdraża worker, potem web, i sprawdza wynik | TOTP; SHA musi być HEAD `main`; zielone CI; wgrane migracje; brak trwającego wdrożenia |

**Czego nie umie (celowo):**
- Nie włącza z powrotem wyłączonych funkcji. Zdjęcie flagi robisz ręcznie SQL-em: `docs/runbooks/hamulce-ksef.md`.
- Nie wgrywa migracji. Pokazuje tylko, że są niewgrane, i odmawia wdrożenia.
- Nie czyta danych klientów. Rola `ops_actor` nie widzi żadnej tabeli, ma dostęp wyłącznie do 4 funkcji w schemacie `ops`.
- Nie zmienia zmiennych w Coolify. Token ma tylko prawa `read` i `deploy`.

## 2. Jak `/wdroz` pilnuje kolejności

API Coolify wdraża zawsze HEAD gałęzi, nie wskazany commit. Bramka:
1. odmawia, jeśli HEAD `main` nie zaczyna się od podanego SHA;
2. odmawia, jeśli brakuje zielonych `Typecheck + Lint + Unit tests` i `Next build`, coś jest czerwone lub w toku;
3. odmawia, jeśli w zakresie od wdrożonej wersji jest migracja, której nie ma w `schema_migrations`;
4. wdraża **worker**, czeka na koniec i sprawdza, czy Coolify zbudował ten SHA;
5. ponownie sprawdza HEAD. Jeśli `main` się przesunął, **zatrzymuje się przed webem** i ostrzega o stanie mieszanym (worker nowy, web stary);
6. wdraża **web** tak samo;
7. sprawdza `/api/health` i stan obu aplikacji w Coolify, potem zapisuje wynik w `audit_logs`.

Postęp przychodzi wiadomościami. Druga osoba dostaje powiadomienie o starcie.

## 3. Konfiguracja jednorazowa (Bartosz)

Kolejność ma znaczenie.

1. **Sieć prywatna.** Hetzner Console → Networks → sieć, w której są `app-1`
   i `db-1` → *Attach server* → `ops-1` (zrobione 1.10.2026, `ops-1` = 10.0.0.4).

   **Pułapka Dockera na `ops-1`:** instalator Coolify ustawił w
   `/etc/docker/daemon.json` pulę `10.0.0.0/8`, więc most `docker0` dostał
   10.0.0.1/24 i przykrył trasę do sieci prywatnej (ruch do `db-1` szedł do
   Dockera). Naprawione 1.10.2026: `"bip": "172.17.0.1/16"`, nowe sieci z
   `10.128.0.0/16`, restart Dockera (16 s); kopia: `daemon.json.bak-2026-10-01`.
   **Po aktualizacji Coolify sprawdź**, czy nie przywrócił starej puli:
   `ip route get 10.0.0.2` na `ops-1` musi wskazywać `dev enp7s0`.
2. **Migracja 00100** — wgrana na `db-1` 1.10.2026 (rola `ops_actor` bez logowania, schemat `ops`).
3. **Hasło roli `ops_actor`.** Bramka loguje się do bazy jako osobny
   użytkownik, który umie tylko czytać stan i wyłączać flagi. Migracja
   utworzyła go bez hasła (repo jest publiczne), więc hasło nadajesz Ty.
   - Wygeneruj hasło bez znaków specjalnych: `openssl rand -hex 24`.
   - Ustaw je (wklejasz dwa razy, znaków nie widać, nic nie zostaje w historii):
     ```bash
     source .agents/infra.env
     ssh -t -i $K root@$DB "docker exec -it $PGC psql -U postgres -c '\password ops_actor'"
     ssh -i $K root@$DB "docker exec $PGC psql -U postgres -c 'ALTER ROLE ops_actor LOGIN;'"
     ```
   - Zapisz hasło w menedżerze haseł — wpiszesz je w kroku 7 w `OPS_DATABASE_URL`.
4. **Token Coolify.** Settings → Advanced → włącz *API Access*. Keys & Tokens →
   nowy token z uprawnieniami **tylko `read` i `deploy`** (bez `write` i `root`).
   Coolify pokazuje token **raz** — jeśli go nie zapisałeś, utwórz nowy.
5. **Bot w Telegramie.** Bot to konto w Telegramie sterowane przez program
   (bramkę). Zakładasz je raz, przez oficjalnego bota Telegrama — @BotFather.
   - W Telegramie wyszukaj **BotFather** (niebieski znaczek weryfikacji,
     login dokładnie `@BotFather`) i naciśnij *Start*.
   - Wyślij `/newbot`.
   - Podaj nazwę wyświetlaną, np. `FaktFlow Bramka`.
   - Podaj login bota — musi kończyć się na `bot` i być wolny, np.
     `faktflow_bramka_bot` (zajęty? spróbuj `faktflow_ops_bot`).
   - BotFather odpowie wiadomością z tokenem po słowach „Use this token to
     access the HTTP API” — wygląda jak `123456789:AAH…` (cyfry, dwukropek,
     długi ciąg znaków). To jest `TELEGRAM_BOT_TOKEN`. Zapisz go w menedżerze
     haseł; nie wysyłaj nikomu i nie wklejaj do czatu z Claude.
   - Opcjonalnie: `/setjoingroups` → wybierz bota → *Disable* (nikt nie doda
     go do grupy; bramka i tak ignoruje grupy).
   - Otwórz swojego bota (link `t.me/<login>` w odpowiedzi BotFathera)
     i naciśnij *Start*. Bez tego bot nie może do Ciebie pisać. Igor robi to samo.
   - Ten sam token może wysyłać alerty (`docs/runbooks/telegram-heartbeat.md`):
     w aplikacjach id=1 i id=2 `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERT_CHAT_IDS`
     (Twoje Id z kroku 8). Wysyłanie alertów nie koliduje z odbieraniem
     poleceń przez bramkę.
   - Wyciek tokenu: BotFather → `/revoke` → wybierz bota → nowy token.
6. **TOTP — drugi czynnik do `/wdroz`.** Jak kod z banku: nawet jeśli ktoś
   przejmie Twój Telegram, nie wdroży bez 6 cyfr z telefonu.
   - Na Macu, w katalogu repo: `node ops/bramka/totp-setup.mjs` — wypisze
     `SEKRET` i adres `otpauth://`.
   - W aplikacji uwierzytelniającej (Google Authenticator, 1Password, Authy):
     *Dodaj* → *Wpisz klucz ręcznie* → nazwa „FaktFlow bramka”, klucz = `SEKRET`,
     typ: oparty na czasie.
   - `SEKRET` wpiszesz w kroku 7. Igor, jeśli ma wdrażać, dodaje ten sam klucz u siebie.
   - Wyczyść terminal (Cmd+K).
7. **Aplikacja bramki w Coolify** (po scaleniu PR — Coolify buduje z `main`).
   Bramka to osobny program, który musi stale działać; uruchamiamy go na `ops-1`.
   - Projekt FaktFlow → środowisko produkcyjne → *+ New* → *Private Repository
     (with GitHub App)* → ta sama aplikacja GitHub co web/worker → repo
     `ezior8888-cpu/ksef-saas`, gałąź `main`, serwer **localhost** (`ops-1`).
   - Build Pack *Dockerfile*, Base Directory `/ops/bramka`, Dockerfile
     Location `/Dockerfile`. Domeny puste, healthcheck wyłączony.
   - Zmienne (`is_preview = false`):

   | Zmienna | Wartość |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | token z kroku 5 |
   | `BRAMKA_USERS` | `twoje_id:Bartosz` (krok 8) |
   | `BRAMKA_TOTP_SECRET` | `SEKRET` z kroku 6 |
   | `OPS_DATABASE_URL` | `postgresql://ops_actor:HASŁO_Z_KROKU_3@10.0.0.2:5432/postgres` |
   | `COOLIFY_API_URL` | `http://coolify:8080/api/v1` |
   | `COOLIFY_API_TOKEN` | token z kroku 4 |
   | `COOLIFY_APP_WEB`, `COOLIFY_APP_WORKER` | UUID aplikacji id=1 i id=2 (koniec adresu strony aplikacji w Coolify) |
   | `GITHUB_TOKEN` | opcjonalnie: fine-grained, tylko odczyt repo (bez niego limit 60 zapytań/h) |

   - *Deploy*. W logach: `start: 1 operator(ów)`, w Telegramie „🟢 Bramka uruchomiona”.
8. **Kto może pisać do bramki (`BRAMKA_USERS`).** Bramka odpowiada tylko
   osobom z listy, wszystkich innych ignoruje.
   - Swój identyfikator: w Telegramie @userinfobot → *Start* → „Id: 123456789”.
   - Igor robi to samo i podaje Ci swój Id; dopisujesz `,987654321:Igor`
     i wdrażasz bramkę ponownie (Redeploy).
   - Albo: Igor pisze do bota, a w logach bramki pojawia się
     `odrzucono wiadomość od from.id=…`.
9. **Sprawdzenie.** Po starcie każdy z listy dostaje „🟢 Bramka uruchomiona”.
   Sprawdź `/status`, `/kolejki` i `/wdroz` (bez argumentów).

## 4. Awarie i bezpieczeństwo

| Sytuacja | Co zrobić |
|---|---|
| Zgubiony telefon | usuń osobę z `BRAMKA_USERS`, wygeneruj nowy sekret TOTP, wdróż bramkę |
| Wyciek tokenu bota | @BotFather → `/revoke`, nowy token w Coolify (bramka i aplikacja, jeśli wspólny) |
| Bramka ma natychmiast przestać działać | Coolify → aplikacja bramki → Stop |
| 5 błędnych kodów TOTP | blokada na 15 min (licznik w pamięci; restart bramki go zeruje) |
| Bramka wdrożyła tylko worker | wiadomość „stan mieszany” (worker nowy, web stary); uruchom `/wdroz` ponownie albo wdroż web ręcznie (`AGENTS.md`) |
| Zmiana kodu bramki | wdrażasz ją ręcznie w Coolify — `/wdroz` obejmuje tylko worker i web |

Bramka działa na **long polling**: nie ma publicznego adresu ani otwartego
portu. Po wdrożeniu bramki przez kilka sekund mogą działać dwie kopie. Telegram
odpowiada wtedy błędem 409, a bramka ponawia próbę z rosnącą przerwą.
