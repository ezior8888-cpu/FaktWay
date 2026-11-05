# F03 — sesje, API i weryfikacja drugiego czynnika

Data: 2026-09-14. Autor: Astra. Kontynuacja zatwierdzona przez Igora („zatwierdzam wszystko i leć dalej”, następnie „kontynuuj”). Gałąź: `codex/security-mfa-challenge`, stan wyjściowy `9b1e43d`, po [pakiecie administracji](FAZA-03-ADMIN-MFA.md). Osobny worktree chroni równoległy wpis Claude’a w DZIENNIK-AUDYT.md.

Właściwe środowisko aplikacji to **Hetzner/Coolify**. Dokument opisuje lokalny kod i dowody testów; nie potwierdza wdrożenia. Pełna faza 3 i odzyskiwanie MFA pozostają otwarte.

## Zamknięte scenariusze w kodzie

- **CYB-F03-07 — zmienione dane sesji.** Poprzedni middleware brał informację o wymaganiu drugiego czynnika z wariantu SDK czytającego `session.user.factors`. Zachowanie poprawnego tokenu AAL1 przy ukryciu czynników w cookies mogło ominąć challenge. Teraz tożsamość i czynniki pochodzą z Auth, a claims dotyczą dokładnie tego samego tokenu. Błąd weryfikacji odmawia dostępu.
- **CYB-F03-08 — prywatne API i operacje konta.** Middleware wcześniej wyłączał API z MFA. Teraz prywatne API zwraca 403 `mfa_required` przed wejściem do handlera. Wspólne `requireUserAndActiveOrg` i `resolveApiUserAndActiveOrg` dodatkowo sprawdzają MFA przed cookies organizacji i utworzeniem klienta service_role. Zmiana hasła oraz żądanie/anulowanie usunięcia konta wymagają drugiego czynnika, jeśli konto go ma. Zwykłe konto bez MFA nadal może korzystać z aplikacji.
- **CYB-F03-09 — limit prób 2FA.** Nowy limiter jest wspólny dla challenge, rozpoczęcia enrollmentu i potwierdzenia enrollmentu: 5 operacji na konto w stałym oknie 300 s od pierwszej próby. Zmiana IP ani przejście do drugiej akcji nie tworzy nowego limitu. Jeden skrypt EVAL atomowo obsługuje licznik i TTL, bez wzrostu listy po każdej próbie. Brak konfiguracji, awaria lub nieprawidłowa odpowiedź powodują odmowę. Ogólny limiter logowania pozostaje bez zmian.
- **CYB-F03-10 — pozorne odzyskanie dostępu.** Kod ratunkowy nie jest już zużywany bez odzyskania sesji. Formularz, historyczny eksport akcji regeneracji i UI nie udają działającego recovery ani nie tworzą nowych nieczynnych kodów. Wcześniejsze kody pozostają w bazie; nie są metodą logowania. Przed enrollmentem widoczna jest informacja o braku samodzielnego odzyskiwania.
- **CYB-F03-11 — administrator bez organizacji.** Nowa strona `/login/two-factor/setup` jest poza layoutem firmy. Wymaga potwierdzonego emaila z ADMIN_EMAILS i zweryfikowanej tożsamości; istniejący czynnik najpierw wymaga challenge. `/admin` nie uruchamia bootstrapu członkostwa. Pierwszy TOTP można skonfigurować bez tworzenia firmy, a po potwierdzeniu wrócić do administracji.
- **CYB-F03-12 — inny zweryfikowany czynnik.** AAL1 z jakimkolwiek zweryfikowanym czynnikiem (również phone/WebAuthn) nie jest traktowane jako konto bez MFA. UI nadal obsługuje TOTP; nieobsługiwany czynnik przy AAL1 zatrzymuje dostęp. Administracja nadal wymaga AAL2 i aktywnego TOTP.

Challenge i enrollment potwierdzają po `mfa.verify` rzeczywiście zweryfikowane AAL2 i zgodność użytkownika. Enrollment akceptuje tylko własny oczekujący TOTP. Nie tworzymy własnego JWT, ciasteczka „MFA zaliczone” ani wyjątku dla odzyskiwania. [Model MFA Supabase](https://supabase.com/docs/guides/auth/auth-mfa).

Uzupełnienie z listopada 2026 (FaktWay 1.0, logowanie biometrią): jest teraz jeden świadomy wyjątek od zdania wyżej. Znacznik `ksef.passkey_session` (`lib/auth/passkey/session-marker.ts`, HMAC po `sub`, `session_id` i czasie) przepuszcza do panelu sesję AAL1 po asercji WebAuthn z weryfikacją użytkownika. Dotyczy tylko bramki panelu (`lib/auth/panel-mfa.ts`). `getVerifiedMfaState` bez zmian zwraca `challenge_required`, więc `/admin`, certyfikat KSeF, płatności, hasło, 2FA, urządzenia i eksport danych konta dalej wymagają kodu TOTP.

## Weryfikacja lokalna

- **103 pliki / 1700 testów Vitest PASS**, pełny typecheck PASS, lint 25 zmienionych plików TS/TSX bez ostrzeżeń PASS.
- Testy sprawdzają fałszywe dane cookies, słabszą sesję, cudzą tożsamość/czynnik/organizację, odwołane członkostwo, błędy Auth i limitera, działanie kont bez MFA oraz administratora bez organizacji.
- Dodatkowy przegląd wykrył utratę odświeżonych cookies w odpowiedzi odmowy API. Test najpierw nie przeszedł; po wspólnym kopiowaniu cookies do odpowiedzi 401/403/503 przeszedł. Przegląd wykrył też przypadek phone/WebAuthn, naprawiony przed końcowym przebiegiem.
- Izolowana kompilacja Next.js webpack w trybie `compile` PASS, w tym nowa strona setup. Kopia bez plików .env i kluczy aplikacji, jawna lista zmiennych procesu oraz syntetyczny adres Supabase na loopback. To nie pełne generowanie stron ani test rzeczywistego logowania. Sentry ostrzega o niepełnym wsparciu tego trybu.
- Dowody lokalne: `faktflow-mfa-final-checks-jnI7iq` (testy, typy, lint, compile) i kopia kompilacji `faktflow-security-compile-F1Oshv`.
- Testy limitera uruchamiają rzeczywisty kod TypeScript z atrapą odpowiedzi EVAL. **Nie wykonano Lua na Redis/Valkey/SRH**, nie potwierdzono rzeczywistego GoTrue, polityk bazy, limitów bezpośredniego Auth ani przeglądarkowego E2E.
- Weryfikacja działania Gitleaks na sztucznym sekrecie PASS. Końcowy wynik skanu przygotowanych zmian i commity są zapisane w [dzienniku](DZIENNIK-ODPORNOSCI-CYBER.md). Przeglądy agentów są kontrolą w obrębie zespołu AI, nie zewnętrznym pentestem.

## Inwentaryzacja: licznik nie jest liczbą luk

Spis nadal obejmuje 305 zapytań service_role: 0 krytycznych, 0 wysokich, 12 średnich, 77 do przejrzenia, 216 oznaczonych „ok”. Wejść jest 101, sygnałów 35. To heurystyka, bez deklaracji bezpieczeństwa kategorii „ok”.

Porównano raporty z bazą 9b1e43d. Przyrost 76→77 dotyczy nieużywanego teraz `countRemainingRecoveryCodes`, dla którego skaner nie znajduje wywołującego. Przyrost sygnałów 33→35 dotyczy dwóch plików akcji settings/account i settings/security: skaner nie rozpoznaje `getVerifiedMfaState` jako sprawdzenia tożsamości po zastąpieniu bezpośredniego `getUser`. Nowa strona setup ma klasyfikację „ok”. Nie zmieniano heurystyk ani wyjątków w celu poprawienia wyniku.

## Odbiór Bartka przed wydaniem

1. Potwierdzić zgodne wersje kodu, workera i schematu oraz konfigurację TOTP rzeczywistego GoTrue na własnym serwerze. Ten pakiet nie dodaje ani nie uruchamia migracji.
2. Na odizolowanym stagingu potwierdzić EVAL, TTL i uprawnienia konta aplikacji przez używany SRH/Valkey. Przećwiczyć wspólne pięć prób, zmianę IP, wygaśnięcie okna, równoczesność i awarię. Awaria limitera ma blokować te operacje MFA.
3. Przejść pełne logowanie użytkownika i operatora bez firmy: enrollment → AAL2 → panel → nowa sesja AAL1 → challenge. Sprawdzić odmowę API 403, odświeżanie cookies, utratę/odebranie czynnika i rzeczywiste zachowanie UI po Server Action.
4. Uzgodnić i przećwiczyć pełne odzyskiwanie z drugą osobą. [Runbook](../runbooks/unlock-account.md) §2 opisuje aktualne ograniczenia. Dostęp do sesji lub dane firmy nie zastępują dowodu tożsamości. Brak odebranego recovery nadal blokuje uznanie obowiązkowego MFA za gotowe do wydania.
5. Osobno zabezpieczyć bezpośrednie wejścia do Auth i PostgREST. Limiter aplikacji nie ogranicza wywołań wykonanych bezpośrednio do GoTrue, a strażniki Next.js nie zastępują polityk MFA/RLS w bazie. Pełny przegląd wszystkich handlerów, publicznych akcji i polityk nadal trwa.
6. Sprawdzić wpływ dodatkowych odczytów Auth na opóźnienia i obciążenie. Ustalić obsługę ewentualnych istniejących kont z innym czynnikiem niż TOTP — brak wspieranej ścieżki ma skutkować odmową, nie pominięciem MFA.
7. Nadal otwarte z wcześniejszego pakietu: odwoływanie sesji po ID, zmiana hasła przy secure_password_change/nonce, Dependency graph i ochrona zmian, stan istniejących migracji oraz pozostałości integracji GitHub–Vercel. Wynik Vercela nie jest odbiorem Hetzner/Coolify.

## Granice i wycofanie

Brak zmian zależności, schematu, konfiguracji serwera, nazw R2_*/UPSTASH_* i backendów jobów. Nie wysyłano wiadomości do użytkowników ani Bartka. Wycofanie tych zmian ponownie otwiera opisane słabości; po wydaniu wymaga decyzji operatora i ochrony zastępczej. Samodzielne recovery pozostaje funkcją niewdrożoną.
