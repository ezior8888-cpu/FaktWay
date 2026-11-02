# Unlock Account Runbook (Faza 35)

Kilka rzeczy może zablokować dostęp user-a do konta. Ten runbook listuje
najczęstsze + procedurę odblokowania.

> Aktualizacja 2026-09-14 dotyczy §2 (MFA). Pozostałe sekcje są historyczne i wymagają porównania z aktualnym kodem oraz własnym serwerem Hetzner/Coolify przed użyciem operacyjnym.

## Macierz scenariuszy

| Symptom (ze strony user-a) | Przyczyna | Sekcja |
|---|---|---|
| "Hasło OK, ale nie wpuszcza" + komunikat "za dużo prób" | Rate limit auth (Faza 28) | §1 |
| "Zgubiłem 2FA, nie mogę się dostać" | TOTP factor — brak dostępu | §2 |
| "Pojawia się 'konto zostało zawieszone'" | Admin suspend albo dispute lost | §3 |
| "Próbuję anulować usunięcie konta" | GDPR deletion request pending | §4 |
| "Logowanie przez Google nie działa" | Account linking conflict | §5 |
| Konto nie istnieje, ale user "na pewno się zarejestrował" | Hard bounce email (Faza 26) | §6 |
| "Zgubiłem telefon, na którym loguję się biometrią" | Urządzenie w `user_passkeys` | §7 |

---

## §1. Rate limit lockout (auth)

**Trigger:** Faza 28 wprowadziła sliding window rate limit:
- Login: 5 prób / 15 min per IP + email
- Register / forgot-password: podobne

Po przekroczeniu user dostaje 429 z `Retry-After`.

### Procedura

1. **Zwykle** — poczekaj okno wygasa (15 min), wszystko wraca.
2. **Awaryjnie** — reset w Upstash Redis:
   ```bash
   # CLI Upstash (https://console.upstash.com/redis/<id>/data)
   DEL "rl:auth:login:<email>"
   DEL "rl:auth:login:<ip>"
   ```
3. **Jeśli legit user (np. dyrektor zapomniał laptopa)** — zresetuj hasło
   z admin panelu: `/admin/users/<userId>` → "Send password reset". User dostanie
   email z linkiem (omija rate limit logowania).

### Co NIE robić

❌ Nie wyłączaj rate limit "tymczasowo" — ataki bruteforce wracają w 30 s.

## §2. Utrata dostępu do aplikacji TOTP

**Stan na 2026-09-14:** samodzielne odzyskiwanie MFA jest niedostępne.
Formularz logowania przyjmuje wyłącznie 6-cyfrowy kod TOTP. Próba użycia
kodu ratunkowego kończy się komunikatem o niedostępności; kod nie jest
zużywany. Nowe kody ratunkowe nie są generowane.

Poprzednia implementacja zużywała kod i przekierowywała użytkownika bez
uzyskania sesji AAL2, co prowadziło do ponownego żądania TOTP. Taki wpis
audytowy nie dowodzi odzyskania dostępu. Wcześniej zapisane kody nie
stanowią obecnie sposobu logowania.

Weryfikacja i konfiguracja TOTP współdzielą limit pięciu operacji na konto
w stałym oknie 300 s od pierwszej próby. Próba po przekroczeniu nie przedłuża
okna. Niedostępność limitera blokuje operację; diagnoza jego dostępności
i uprawnień EVAL należy do operatora używanego SRH/Valkey.

### Obsługa zgłoszenia

1. Poinformuj użytkownika o braku samodzielnego odzyskiwania i przekaż
   zgłoszenie właścicielowi usługi. Kontakt: support@faktflow.pl.
   Nie obiecuj terminu ani sposobu resetu, którego nie wdrożono.
2. Właściciel odpowiada za zatwierdzenie procedury i potwierdzenie tożsamości
   zgłaszającego przez niezależne dowody i kanały. Sam dostęp do sesji AAL1,
   adres e-mail, dane faktury lub znajomość danych firmy nie wystarczają do
   wyłączenia drugiego czynnika.
3. Panel administracji nie ma obecnie opisanego wcześniej przycisku
   „Disable 2FA”. Ten runbook nie jest zgodą ani instrukcją wykonania resetu.

### Warunki przygotowania i odbioru pełnego odzyskiwania

Lokalny SDK udostępnia `supabase.auth.admin.mfa.listFactors` oraz
`supabase.auth.admin.mfa.deleteFactor` z identyfikatorami użytkownika
i czynnika. Są to operacje administracyjne; usunięcie czynnika nie wystawia
sesji AAL2 i nie dowodzi unieważnienia wszystkich starych sesji.
Zwykłe `supabase.auth.mfa.unenroll` wymaga AAL2 dla zweryfikowanego czynnika.

Zanim właściciel dopuści procedurę odzyskania, potrzebne są:

- potwierdzenie tożsamości, uprawnień wykonawcy i zakresu resetu;
- obsługa pozostałych kodów, współbieżnych żądań i częściowych awarii;
- audyt operacji i powiadomienie użytkownika;
- test odwołania starych sesji, ponownego logowania, enrollmentu nowego TOTP
  i weryfikacji sesji wystawionej przez Auth;
- dowód, że dostęp administracyjny nadal wymaga poprawnego AAL2 i aktywnego
  TOTP, także przy błędach, starych tokenach i niedokończonym odzyskiwaniu.

Odbiór pełnego odzyskiwania pozostaje otwarty. Nie dodajemy wyjątków
w strażnikach MFA ani sygnałów w ciasteczkach lub metadata zastępujących AAL2.

## §3. Konto zawieszone (admin suspend / dispute lost)

**Trigger:** admin manualnie kliknął "Suspend" w `/admin/users` (np. fraud,
TOS violation) ALBO przegraliśmy dispute Stripe (zob.
[refund-and-disputes.md](./refund-and-disputes.md) §2).

### Procedura

1. **Sprawdź powód** — `admin_user_notes` powinno mieć notatkę z czasem
   i actor.
2. **Jeśli legit (fraud, TOS)** — nie odblokowujemy. User dostaje email z
   referencem do TOS i opcją appeal przez `support@faktflow.pl`.
3. **Jeśli pomyłka admin-a** — `/admin/users/<userId>` → "Unsuspend". User
   dostaje email "konto przywrócone".

### Specjalny przypadek — dispute lost

Suspend był automatyczny po `dispute.lost` webhook (Faza 25/35). Nie
odblokowuj bez:
- Zapłaty disputed kwoty + opłaty Stripe ($15-25).
- Pisemnego zobowiązania że to się nie powtórzy.

## §4. GDPR deletion pending — user chce anulować

**Trigger:** user kliknął "Usuń konto" w `/settings/account`, ale chce się
rozmyślić w trakcie 14-dniowego cooling-off ([ADR-0006](../adr/0006-gdpr-14d-cooling-off.md)).

### Procedura — kanonicznie

1. User dostał email z linkiem `/gdpr/cancel?token=<HMAC>` — klika.
2. Walidacja tokenu (HMAC + 14d expiry) → UPDATE `gdpr_deletion_requests`
   `status = canceled`.
3. User widzi "Konto przywrócone, dziękujemy że zostajesz".

### Procedura — awaryjnie (link nie działa)

Jeśli token wygasł / email zgubiony:

1. `/admin/users/<userId>` → tab "GDPR" → znajdź pending request.
2. "Cancel deletion" → status = `canceled`, audit log.
3. Email do user-a manualnie z `/admin`.

**Czas krytyczny:** po `scheduled_for` cron drenuje request — nie da się
już cofnąć. Wtedy pełen restore z R2 snapshotu (zob.
[backup-restore.md](./backup-restore.md)).

## §5. Google OAuth conflict

**Trigger:** user zarejestrował się email+password, próbuje teraz Google OAuth
tym samym emailem. Supabase Auth łączy je tylko gdy email jest verified.

### Procedura

1. Sprawdź w Supabase Dashboard → Auth → Users → wyszukaj po email.
2. Jeśli `email_confirmed_at` jest null:
   - User powinien dostać welcome email z linkiem verify.
   - Awaryjnie: `/admin/users/<userId>` → "Send verification email".
3. Po verify — Google OAuth zaczyna działać.

## §6. Hard bounce — user "nie istnieje"

**Trigger:** Faza 26 — Resend webhook `email.hard_bounced` deaktywuje konto
(emaile do niego nie idą, więc i tak user się nie zaloguje przez password reset).

### Procedura

1. `/admin/users` → wyszukaj — flag "bounced".
2. Zapytaj user-a o **inny adres email** (różny od bouncującego).
3. `/admin/users/<userId>` → "Change email" (Server Action zmienia w
   `auth.users` + wysyła verify do nowego).
4. Po verify — odznacz bounce flag, konto żyje.

## §7. Zgubione urządzenie z logowaniem biometrią

**Trigger:** klient zgubił telefon albo chce odciąć urządzenie, a sesja na nim może być
otwarta nawet 90 dni (logowanie biometrią liczy się jak „Zapamiętaj mnie”).

### Procedura

1. Klient ma hasło i kod z aplikacji: Ustawienia → Bezpieczeństwo → Logowanie biometrią →
   Usuń. Usunięcie wylogowuje pozostałe urządzenia i zapisuje `auth.passkey_removed`.
2. Klient nie może się zalogować: najpierw potwierdź tożsamość jak w §2, potem usuń na `db-1`
   urządzenia i sesje konta (przycisk wymuszenia wylogowania w `/admin/users` jest dziś
   niedostępny, `forceLogoutAction`):
   `DELETE FROM public.user_passkeys WHERE user_id = '<userId>';`
   `DELETE FROM auth.sessions WHERE user_id = '<userId>';`
   Te polecenia nie zostawiają wpisu w `audit_logs`, więc zapisz je w zgłoszeniu.
3. Zawieszenie konta w `/admin/users/<userId>` zatrzymuje także logowanie biometrią.

---

## Co loguje audit_logs

Każda akcja "unlock/suspend/disable 2FA/cancel GDPR" zapisuje:
- `actor_id` — admin który zrobił
- `event` — typ akcji
- `target_user_id` — kogo dotyczy
- `metadata` — kontekst (powód, IP, oryginalny stan)

Audit jest **immutable** (trigger Faza 28, migracja 00052) — nie da się go
zatrzeć.

## Powiązane

- [refund-and-disputes.md](./refund-and-disputes.md) — refundy / chargeback
- [docs/support/escalation-matrix.md](../support/escalation-matrix.md) — kiedy eskalować
- [ADR-0005](../adr/0005-2fa-supabase-mfa-native.md) — dlaczego 2FA Supabase native
- [ADR-0006](../adr/0006-gdpr-14d-cooling-off.md) — dlaczego 14d cooling-off
