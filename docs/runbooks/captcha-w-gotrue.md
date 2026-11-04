# Captcha (Cloudflare Turnstile) sprawdzana w GoTrue

Od 25.10.2026. Wcześniej token z widżetu Turnstile sprawdzała tylko aplikacja,
w akcjach formularzy. Po tym kroku sprawdza go GoTrue, czyli każda droga do
logowania hasłem, rejestracji i resetu hasła, a nie tylko nasze formularze.

Kontrola stanu w każdej chwili (tylko odczyt):

```bash
./scripts/ops/kontrola-captcha-gotrue.sh
```

| Werdykt | Aplikacja (`AUTH_CAPTCHA_IN_GOTRUE`) | GoTrue (`GOTRUE_SECURITY_CAPTCHA_ENABLED`) | Znaczenie |
|---|---|---|---|
| A | brak / `false` | brak / `false` | przed krokiem, token sprawdza aplikacja |
| B | `true` | brak / `false` | przejściowy, token idzie do GoTrue, ale GoTrue go jeszcze nie wymaga |
| C | `true` | `true` | **docelowy** |
| D | brak / `false` | `true` | **źle**: aplikacja zużywa token, GoTrue dostaje go bez tokenu, logowanie nie działa |

## Dlaczego przełącznik i kolejność

Token Turnstile działa tylko raz. Gdy aplikacja sprawdza go sama, zużywa go,
więc GoTrue nie może sprawdzić go drugi raz. Przełącznik `AUTH_CAPTCHA_IN_GOTRUE`
mówi aplikacji: nie sprawdzaj, przekaż token do GoTrue (`captchaToken`).

Kolejność jest jedna: **najpierw aplikacja, potem GoTrue**. Między krokami
(stan B) formularze chroni pole-pułapka i limity prób, a nikt nie dostaje
błędu. Odwrotna kolejność to stan D: każde logowanie kończy się komunikatem
„Nie udało się potwierdzić, że nie jesteś botem”.

## Wymagania

- Na produkcji kod z PR „Logowanie: niewidoczny Turnstile…” (#330) i z PR
  „Captcha sprawdzana w GoTrue” (ten runbook). Widżet jest wtedy także
  w oknach z ponownym hasłem w ustawieniach: zmiana hasła, wyłączenie 2FA,
  usunięcie konta i jego anulowanie.
- Skrypt kontrolny pokazuje werdykt A.

## Krok 1. Aplikacja (Coolify, aplikacja `id=1`)

1. Panel Coolify (tunel z `AGENTS.md`, „Pułapki”) → aplikacja `id=1` →
   **Environment Variables** → dodaj `AUTH_CAPTCHA_IN_GOTRUE` = `true`.
   Zmienna produkcyjna, nie jej bliźniak `is_preview`.
2. **Restart** aplikacji (nie trzeba przebudowy, zmienna jest czytana w czasie
   działania).
3. `./scripts/ops/kontrola-captcha-gotrue.sh` → werdykt **B**.

Worker (`id=2`) tej zmiennej nie potrzebuje.

## Krok 2. GoTrue (Coolify, usługa Supabase na db-1)

1. Skopiuj wartość `TURNSTILE_SECRET_KEY` z aplikacji `id=1` (ten sam sekret
   Turnstile, inny GoTrue odrzuci tokeny z widżetu).
2. Usługa Supabase → **Edit Compose File** → w `supabase-auth` → `environment:`
   dopisz trzy linie:

   ```yaml
         GOTRUE_SECURITY_CAPTCHA_ENABLED: '${GOTRUE_SECURITY_CAPTCHA_ENABLED:-false}'
         GOTRUE_SECURITY_CAPTCHA_PROVIDER: turnstile
         GOTRUE_SECURITY_CAPTCHA_SECRET: '${GOTRUE_SECURITY_CAPTCHA_SECRET}'
   ```

   Zapisz. Wpis w pliku compose, a nie ręczna zmiana kontenera na db-1:
   Coolify odtwarza kontenery ze swojej konfiguracji, więc zmiana zrobiona
   obok niego zniknęłaby po najbliższym restarcie.
3. Usługa Supabase → **Environment Variables**: `GOTRUE_SECURITY_CAPTCHA_ENABLED`
   = `true`, `GOTRUE_SECURITY_CAPTCHA_SECRET` = wartość z punktu 1.
4. **Restart** usługi Supabase. Restart obejmuje cały stos (Postgres, API,
   logowanie), więc aplikacja przez 1–2 minuty zwraca błędy. Rób to poza
   godzinami pracy klientów.
5. `./scripts/ops/kontrola-captcha-gotrue.sh` → werdykt **C** i „taki sam
   jak TURNSTILE_SECRET_KEY”.

## Krok 3. Sprawdzenie w przeglądarce

Na `https://faktflow.pl`, w zwykłej przeglądarce:

- logowanie: najpierw błędne hasło, potem poprawne, bez odświeżania strony,
- „Nie pamiętasz hasła?”: przychodzi mail z linkiem,
- Ustawienia → Bezpieczeństwo → zmiana hasła (z kodem z maila, jeśli GoTrue
  go wymaga).

Komunikat „Nie udało się potwierdzić, że nie jesteś botem” przy każdej próbie
to stan D albo zły sekret: uruchom skrypt kontrolny, on mówi, co poprawić.

## Wycofanie

Kolejność odwrotna niż przy włączaniu, żeby nie przejść przez stan D:

1. Usługa Supabase → `GOTRUE_SECURITY_CAPTCHA_ENABLED` = `false` → Restart
   usługi (te same 1–2 minuty przerwy).
2. Skrypt → werdykt **B**. Tak można zostać: aplikacja przekazuje token,
   GoTrue go nie sprawdza, formularze chroni pole-pułapka i limity.
3. Pełny powrót do sprawdzania w aplikacji: `AUTH_CAPTCHA_IN_GOTRUE` = `false`
   w aplikacji `id=1` → Restart → werdykt **A**.

## Co jeszcze warto wiedzieć

- Akcje serwera wołają GoTrue z app-1, więc GoTrue widzi adres app-1, a nie
  klienta. Ustawienia limitów GoTrue to osobna decyzja (plan skalowania,
  sesja 25).
- Logowanie przez Google, odświeżanie sesji i kody 2FA nie wymagają tokenu
  (GoTrue pomija captcha dla `pkce`, `refresh_token` i `id_token`).
- Wywołania z kluczem `service_role` (joby, panel admina) GoTrue przepuszcza
  bez captcha.
- Testowe logowanie do testów obciążeniowych (`/api/dev/load-test-session`)
  nie przejdzie przy captcha w GoTrue. Działa tylko poza produkcją.
- Kod: `lib/security/bot-check.ts` (przełącznik, rozpoznanie odmowy captcha),
  testy `tests/unit/captcha-w-gotrue.test.ts` i
  `tests/unit/kontrola-captcha-gotrue.test.ts`.
