# Key Rotation Runbook (Faza 28)

> ## ⚠️ TEN DOKUMENT JEST NIEAKTUALNY
>
> Kroki rotacji odwołują się do zmiennych w Vercelu i jobów Inngest; zmienne ustawia się dziś w Coolify (dwie aplikacje: web i worker, `is_preview = false`). Produkcja stoi na **Hetznerze pod Coolify**,
> joby chodzą na **pg-boss**, baza to **Supabase self-hosted** na `db-1`.
>
> **Aktualna procedura rotacji: [`rotacja-kluczy.md`](rotacja-kluczy.md)**
> (kontrola po każdym kroku: `./scripts/ops/rotacja-kluczy.sh`). Pozostałe:
> `AGENTS.md`, sekcja „Infrastruktura i dostępy", oraz
> `docs/runbooks/joby-pg-boss.md`. Nie wykonuj poleceń z tego pliku
> na produkcji (AUD-110).

---

Procedury rotacji kluczy szyfrowania i sekretów. Wykonuj przy:

- Plotkach o wycieku (proaktywnie),
- Po opuszczeniu firmy przez osobę z dostępem,
- Co rok jako rotacja prewencyjna.

---

## 1. `KSEF_CREDENTIALS_ENCRYPTION_KEY`

Szyfruje credentials KSeF w `tenants.ksef_credentials_encrypted` (AES-256-GCM
przez [lib/ksef/credentials-crypto.ts](../../lib/ksef/credentials-crypto.ts)).

### Ryzyko utraty / wycieku

- Wyciek klucza ➜ atakujący może odszyfrować KSeF credentials wszystkich
  tenantów = pełny dostęp do wystawiania faktur w ich imieniu.
- Utrata klucza ➜ nie można odszyfrować istniejących credentials, tenanci
  muszą przejść re-onboarding (upload cert+key na nowo).

### Procedura rotacji

**Wymagany downtime:** ~5 min (KSeF submit zawieszony na czas migracji).

1. **Wygeneruj nowy klucz**
   ```bash
   openssl rand -hex 32
   ```

2. **Dodaj jako nową env var** w Vercel (Production + Preview):
   - `KSEF_CREDENTIALS_ENCRYPTION_KEY_NEW` = nowy klucz
   - **Zostaw `KSEF_CREDENTIALS_ENCRYPTION_KEY` bez zmian** (potrzebny do decrypt
     dotychczasowych).

3. **Stwórz Inngest job `migrate-ksef-credentials-key`** (jednorazowy):
   - Czyta wszystkie wpisy `tenants.ksef_credentials_encrypted`.
   - Decrypt starym kluczem ➜ encrypt nowym ➜ UPDATE.
   - Batch 100, throttle 1/s żeby nie zarżnąć DB.

4. **Po sukcesie**:
   - Promote `KSEF_CREDENTIALS_ENCRYPTION_KEY_NEW` ➜ `KSEF_CREDENTIALS_ENCRYPTION_KEY`
     (usuń stary, zmień nazwę nowego).
   - Usuń env var `KSEF_CREDENTIALS_ENCRYPTION_KEY_NEW`.
   - Redeploy.

5. **Audit**: zapisz w `audit_logs` z `action='admin.key_rotated'` (TODO: dodać
   do `AuditAction` w Krok 8 jeśli nie istnieje).

---

## 2. `STRIPE_WEBHOOK_SECRET`

Weryfikuje webhook signature w `app/api/stripe/webhook/route.ts`.

### Procedura

1. **Stripe Dashboard** ➜ Developers ➜ Webhooks ➜ "Roll secret".
2. Stripe pokazuje **nowy secret tylko raz** — skopiuj natychmiast.
3. Vercel ➜ Environment Variables ➜ update `STRIPE_WEBHOOK_SECRET`.
4. Redeploy.
5. **Stripe pamięta stary secret przez ~24h** — overlap window żeby webhooki
   in-flight zdążyły. Po 24h stary jest invalid.

**Bez downtime** jeśli redeploy < 24h od roll.

---

## 3. `RESEND_WEBHOOK_SECRET`

Svix signature dla `app/api/email/resend-webhook/route.ts`.

### Procedura

1. **Resend Dashboard** ➜ Webhooks ➜ wybierz endpoint ➜ "Rotate Signing Secret".
2. Resend pokazuje nowy secret raz.
3. Vercel ➜ update `RESEND_WEBHOOK_SECRET`.
4. Redeploy.

**Resend NIE robi overlap** — między rotacją a deployem webhooki padają.
Plan: wybierz okno low-traffic (noc PL).

---

## 4. `EMAIL_UNSUBSCRIBE_SECRET`

HMAC dla one-click unsubscribe tokenów ([lib/email/unsubscribe-token.ts](../../lib/email/unsubscribe-token.ts)).

### Procedura

1. **Wygeneruj nowy**: `openssl rand -hex 32`.
2. Vercel ➜ update.
3. Redeploy.

**Side effect**: wszystkie istniejące unsubscribe linki w mailach
WSTECZNYCH przestają działać. Wysłane w ostatnich 24h emaile → user
musi kliknąć z świeższego maila lub wejść w settings.

**Rekomendacja**: rotuj rzadko (raz na rok), poinformuj userów wcześniej.

---

## 5. `NEXTAUTH_SECRET` / Supabase JWT secret

Supabase zarządza JWT signing key wewnętrznie — nie da się rotować z poziomu
aplikacji bez project reset.

### Side effects rotacji

- Wszystkie aktywne sesje (access_token + refresh_token) przestają być
  ważne.
- Userzy zostają wylogowani globalnie.
- Wymaga ponownego logowania (+ 2FA dla mających MFA factor).

### Procedura

1. **Supabase Dashboard** ➜ Project ➜ Settings ➜ API ➜ "Rotate JWT secret".
2. Po rotacji wszystkie tokeny są invalid — UI app pokazuje session expired.
3. Monitoruj `auth.password_reset_requested` i support tickety przez 24h.

**Use case**: tylko po confirmed breach. Inaczej damage do UX > benefit.

---

## 6. `TURNSTILE_SECRET_KEY`

Bot protection ([lib/security/turnstile.ts](../../lib/security/turnstile.ts)).

### Procedura

1. **Cloudflare Dashboard** ➜ Turnstile ➜ Site ➜ "Rotate Secret Key".
2. Vercel ➜ update.
3. Redeploy.

**Brak overlap** — po rotacji tokeny wygenerowane starym sitekey są
invalid. Site key jest stały (publiczny), tylko secret się zmienia.

---

## 7. `SLACK_WEBHOOK_URGENT` / `SLACK_WEBHOOK_BUGS` / `SLACK_WEBHOOK_METRICS`

Slack incoming webhooks ([lib/alerts/slack.ts](../../lib/alerts/slack.ts)).

### Procedura

1. **Slack** ➜ App config ➜ Incoming Webhooks ➜ Regenerate URL.
2. Vercel ➜ update.
3. Redeploy.

Stary URL przestaje działać natychmiast. Krótkie okno braku alertów
(< 1 min między update a redeploy).

---

## 8. Plan rotacji prewencyjnej

| Sekret | Częstotliwość | Notatki |
|---|---|---|
| `KSEF_CREDENTIALS_ENCRYPTION_KEY` | 12 mc | Wymaga migracji 1-time |
| `STRIPE_WEBHOOK_SECRET` | 12 mc | Bezbolesne (24h overlap) |
| `RESEND_WEBHOOK_SECRET` | 12 mc | Wymaga okna low-traffic |
| `EMAIL_UNSUBSCRIBE_SECRET` | 24 mc | Side effect na stare maile |
| `NEXTAUTH_SECRET` (Supabase JWT) | NIE rotuj prewencyjnie | Tylko po breach |
| `TURNSTILE_SECRET_KEY` | 12 mc | Bez overlap |
| Slack webhooks | 6 mc | Mniej krytyczne |

Wpis w kalendarzu z 7-dniowym wyprzedzeniem przed każdą rotacją.

---

## 9. Co po incydencie breach

1. **Natychmiast rotuj wszystkie powyższe** (kolejność: KSeF > Stripe > rest).
2. Wymuszony logout wszystkich userów (`auth.signOut('global')` per user).
3. Skontaktuj się z `pomoc@faktflow.pl` + DPO (RODO art. 33 — 72h).
4. UODO notification (jeśli breach dotyczy danych osobowych).
5. Komunikat dla userów w panelu + mail transactional.
6. Post-mortem w `docs/incidents/<YYYY-MM-DD>-<slug>.md`.
