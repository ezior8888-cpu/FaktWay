# Limit czasu sesji w GoTrue: wylogowanie po 30 dniach bezczynności

Krok 8.5 planu kompletnej aplikacji. Bez tego ustawienia sesje GoTrue nie
wygasają same, więc lista „Zalogowane urządzenia” (Ustawienia → Bezpieczeństwo)
pokazuje też dawno zamknięte przeglądarki. Decyzja przyjęta według rekomendacji
sesji planu, do potwierdzenia przez Bartosza przy scalaniu: **30 dni
bezczynności (720 h), bez sztywnego limitu całkowitego** (`TIMEBOX` zostaje
nieustawiony).

Lokalnie i w CI limit ustawia `supabase/config.toml` (`[auth.sessions]`,
`inactivity_timeout = "720h"`). **Produkcji ta zmiana nie dotyka.** Robi to
Bartosz, tak samo jak captcha (patrz [captcha-w-gotrue.md](./captcha-w-gotrue.md)):
zmienne GoTrue ustawia się w usłudze Supabase w Coolify na `db-1`, nie ręcznie
w kontenerze (Coolify odtwarza kontenery ze swojej konfiguracji).

## Jak to działa (GoTrue)

- `GOTRUE_SESSIONS_INACTIVITY_TIMEOUT` to czas od ostatniego odświeżenia tokenu
  (`refreshed_at` sesji; aplikacja odświeża sesję mniej więcej co godzinę, gdy
  ktoś jej używa). Sesja nieużywana dłużej niż limit jest odrzucana przy
  następnym użyciu albo odświeżeniu: użytkownik widzi ekran logowania.
- Wiersz w `auth.sessions` nie znika sam w chwili upływu limitu, dlatego ekran
  przy takim urządzeniu pisze „Wygaśnie przy następnej próbie użycia”.
- Sesje już istniejące też podlegają limitowi (sprawdzenie idzie po dacie
  ostatniego odświeżenia), więc po restarcie bardzo stare sesje przestaną działać.
- Źródło: dokumentacja Supabase Auth (Configuration → `GOTRUE_SESSIONS_*`)
  i klucz `inactivity_timeout` w `[auth.sessions]` CLI Supabase.

## Krok dla Bartosza

1. `source .agents/infra.env`, potem panel Coolify tunelem
   (`ssh -i $K -N -L 8000:localhost:8000 root@$OPS`, [coolify-pulapki.md](./coolify-pulapki.md)).
2. Usługa Supabase na `db-1` (`$DB`) → **Edit Compose File** → w
   `supabase-auth` → `environment:` dopisz:

   ```yaml
         GOTRUE_SESSIONS_INACTIVITY_TIMEOUT: '${GOTRUE_SESSIONS_INACTIVITY_TIMEOUT:-}'
   ```

3. Usługa Supabase → **Environment Variables**:
   `GOTRUE_SESSIONS_INACTIVITY_TIMEOUT` = `720h`. Nie ustawiaj
   `GOTRUE_SESSIONS_TIMEBOX`.
4. **Restart** usługi Supabase. Obejmuje cały stos, więc aplikacja przez 1 do 2
   minuty zwraca błędy; rób to poza godzinami pracy klientów.

## Sprawdzenie skutku

```bash
source .agents/infra.env
ssh -i $K root@$DB "docker exec \$(docker ps --format '{{.Names}}' | grep -m1 'supabase-auth') env | grep GOTRUE_SESSIONS"
```

Oczekiwane: `GOTRUE_SESSIONS_INACTIVITY_TIMEOUT=720h` i brak `TIMEBOX`.
Skutek widoczny: Ustawienia → Bezpieczeństwo → przy urządzeniu bez aktywności
ponad 30 dni jest napis „Wygaśnie przy następnej próbie użycia”; po próbie
użycia takiego urządzenia pojawia się ekran logowania.

## Wycofanie

Usuń zmienną (albo ustaw pustą) w Environment Variables i zrób Restart usługi.
Sesje znów nie wygasają same.
