# Runbook: Telegram (alerty + raport dzienny) i heartbeat workera

> Krok 3 planu automatyzacji. Kod: `lib/alerts/telegram.ts`, `lib/alerts/slack.ts`
> (`alertCritical`), `lib/jobs/runners/daily-summary-email.ts` (`buildTelegramReport`),
> `lib/jobs/heartbeat.ts` + cron `cron.ops-heartbeat`.

## Co to daje

| Sygnał | Skąd | Dokąd | Kiedy |
|---|---|---|---|
| Alert krytyczny (KSeF niedostępny, kolejka offline, Stripe, VAT, uzgodnienia KSeF…) | `critical-alerts-monitor` co 5 min | Slack `#urgent` **i** Telegram (z dźwiękiem) | od razu, deduplikacja 30 min |
| Raport dzienny (rejestracje, faktury, KSeF, płatności, błędy — same liczby) | `daily-summary-email` 06:00 | e-mail do `ADMIN_EMAILS` **i** Telegram (bez dźwięku) | codziennie |
| Heartbeat workera | `cron.ops-heartbeat` co minutę — **tylko gdy baza odpowiada** | zewnętrzny strażnik (Healthchecks.io albo Uptime Kuma push) | brak pinga przez okres karencji = alarm u strażnika |

Alert krytyczny uznaje się za dostarczony, jeśli potwierdzi go **choć jeden** kanał.
Bez zmiennych Telegrama wszystko działa jak dotąd (sam Slack).

## Ustawienie — ok. 20 minut, robi człowiek

### 1. Bot Telegrama (5 min)

1. W Telegramie otwórz **@BotFather** → `/newbot` → nazwa np. „FaktFlow Ops” →
   nazwa użytkownika kończąca się na `bot` (np. `faktflow_ops_bot`).
2. BotFather poda **token**. To sekret — tylko do Coolify, nigdzie indziej.
3. **Bartosz i Igor** otwierają czat z botem i wysyłają `/start`
   (bot nie może pisać do kogoś, kto go nie uruchomił).
4. Identyfikatory czatów: w przeglądarce otwórz
   `https://api.telegram.org/bot<TOKEN>/getUpdates` i odczytaj `message.chat.id`
   dla obu osób (liczby dodatnie). Zamknij kartę — adres zawiera token.

### 2. Coolify — zmienne (5 min)

Na **obu** aplikacjach (id=1 web, id=2 worker), wariant produkcyjny (`is_preview = false`):

| Zmienna | Wartość |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token z BotFathera |
| `TELEGRAM_ALERT_CHAT_IDS` | dwa ID po przecinku, np. `123456789,987654321` |

Tylko na **workerze** (id=2): `OPS_HEARTBEAT_URL` (krok 3).
Zmienne zaczynają działać po ponownym wdrożeniu obu aplikacji.

### 3. Strażnik heartbeatu (5 min)

**Zalecane: Healthchecks.io** (zewnętrzny — działa, nawet gdy padnie cały Hetzner;
plan Hobbyist darmowy, 20 sprawdzeń).

1. Załóż konto, dodaj check „faktflow-worker”: **Period 1 min, Grace 5 min**.
2. Integracja: Telegram (albo e-mail, jeśli Telegram nie jest dostępny w planie —
   [DO WERYFIKACJI] przy zakładaniu).
3. Skopiuj **ping URL** (`https://hc-ping.com/<uuid>`) do `OPS_HEARTBEAT_URL` na workerze.

Alternatywa: monitor typu **Push** w Uptime Kuma (heartbeat 60 s) — ale Kuma stoi na
`ops-1`, więc przy awarii `ops-1` nikt nie dostanie alarmu.

### 4. Zewnętrzny monitoring HTTP (5 min)

**UptimeRobot** (plan darmowy dopuszcza użytek komercyjny): monitor HTTP(S)
`https://faktflow.pl/api/health` co 5 min, kontakt alarmowy: Telegram albo e-mail.

## Sprawdzenie po wdrożeniu

1. Raport dzienny przyjdzie następnego dnia o 06:00. Żeby sprawdzić od razu, z kontenera
   workera (`docker exec -it <worker> sh`):
   ```bash
   node --import ./lib/jobs/server-only-hook.mjs --import tsx -e "require('./lib/alerts/telegram.ts').sendTelegramMessage('Test FaktFlow ✅', { silent: true }).then(n => console.log('dostarczono do', n, 'czatów'))"
   ```
   Oczekiwane: `dostarczono do 2 czatów`.
2. Healthchecks.io: check zmienia się na „up” w ciągu ~1 minuty od startu workera.
3. Test alarmu heartbeatu (opcjonalnie, poza godzinami pracy): zatrzymaj worker w Coolify
   na 6 minut → przychodzi alarm → uruchom ponownie → „up”.

## Gdy coś nie działa

| Objaw | Przyczyna | Co zrobić |
|---|---|---|
| Brak wiadomości na Telegramie | brak `/start` u odbiorcy, zły chat ID, brak zmiennej na danej aplikacji | sprawdź `getUpdates`, zmienne na obu aplikacjach, logi workera `[telegram] delivery was not confirmed` |
| Alarm heartbeatu, a worker działa | baza/PostgREST nie odpowiada (heartbeat celowo milczy) albo zmienna `OPS_HEARTBEAT_URL` zła | `docker logs` workera, `/api/health`, ręczny `curl` na ping URL |
| Za dużo wiadomości | deduplikacja alertów krytycznych to 30 min na rodzaj | wycisz czat bota na czas incydentu; nie usuwaj zmiennych |
| Wyciek tokenu | — | BotFather → `/revoke`, nowy token w Coolify, wdrożenie obu aplikacji |

## Prywatność

Wiadomości trafiają na serwery Telegrama. Kod wysyła wyłącznie liczby i opisy alertów —
bez nazw firm, NIP-ów, e-maili i treści faktur. Nie dopisuj do alertów krytycznych danych
klientów (regulamin botów Telegrama zakazuje też używania danych do trenowania modeli).
