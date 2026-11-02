# PostHog — gdzie wkleić co (szablon)

W tym projekcie **nie wklejasz** `posthog.init('phc_…', …)` do losowego pliku `.tsx`.  
Klucz i host trzymasz w **`.env.local`**; init przeglądarki jest w **`instrumentation-client.ts`** → **`lib/analytics/init-posthog-browser.ts`** (`defaults: '2026-01-30'` = `$pageview` + `$pageleave`).

---

## 1. Lokalnie — plik **`.env.local`** (w **rootcie** repo, obok `package.json`)

Utwórz lub edytuj plik **`.env.local`** (jest w `.gitignore` — nie trafia do Gita).

Wklej poniższe i **podmień** tylko wartości w wierszu `NEXT_PUBLIC_POSTHOG_KEY`:

```env
# PostHog — Project API Key z: PostHog → Project settings → Project API Key
NEXT_PUBLIC_POSTHOG_KEY=Wklej_tutaj_swoj_klucz_phc_

# Region EU (jak w panelu PostHog); zostaw jak jest, chyba że masz inny region
NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com
```

Zapisz plik i **zrestartuj** `pnpm dev` (zmienne `NEXT_PUBLIC_*` ładowane przy starcie builda / dev).

**Uwaga (zgoda):** capture działa **tylko** gdy w localStorage jest `ff_analytics_consent` = `"granted"`. Jeśli wcześniej kliknąłeś „Tylko niezbędne”, kliknij „Włącz analitykę” na `/legal/cookies`. Zdarzenia z serwera czytają zgodę z `users.analytics_consent`.

---

## 2. Produkcja (np. **Vercel**)

**Vercel → Twój projekt → Settings → Environment Variables**

Dodaj **te same nazwy** co wyżej:

| Name | Value (wklej) |
|------|----------------|
| `NEXT_PUBLIC_POSTHOG_KEY` | Twój `phc_…` z PostHoga |
| `NEXT_PUBLIC_POSTHOG_HOST` | `https://eu.i.posthog.com` (lub host z Twojego regionu) |

Zapisz i **Redeploy**, żeby zmienne trafiły do bundle.

---

## 3. Odpowiednik snippeta z panelu PostHog (dla orientacji)

W panelu PostHog pod **Web** często widzisz coś w stylu:

```js
import posthog from 'posthog-js'

posthog.init('phc_.....', {
  api_host: 'https://eu.i.posthog.com',
  defaults: '2026-01-30',
})
```

U nas to jest **zbudowane tak**:

| Fragment z panelu | U nas |
|-------------------|--------|
| `'phc_.....'` | `process.env.NEXT_PUBLIC_POSTHOG_KEY` (wartość z **`.env.local`** / Vercel) |
| `api_host: 'https://eu.i.posthog.com'` | `api_host: '/ingest'` — **reverse proxy** w `next.config.ts` (mniej ad-blocków); ruch i tak trafia do EU |
| `defaults: '2026-01-30'` | Stała `POSTHOG_INIT_DEFAULTS` w `lib/analytics/browser-posthog.ts` |
| `import posthog` + init w pliku | **`instrumentation-client.ts`** → `initPosthogBrowser()` (pakiet `posthog-js`) |

**`ui_host`:** w init ustawiamy `process.env.NEXT_PUBLIC_POSTHOG_HOST` (toolbar / linki w UI PostHoga) — dlatego w env zostawiasz prawdziwy host `https://eu.i.posthog.com`.

---

## 4. Czego **nie** rób

- Nie wklejaj jawnego `phc_…` do `app/layout.tsx`, `browser-posthog.ts` ani innych plików **commitowanych** do Gita.
- Nie duplikuj drugiego `posthog.init` — tylko `initPosthogBrowser()` w `instrumentation-client.ts`.
- **Scroll depth (3/3 w wizardzie):** w PostHog → **Project settings → Web analytics** włącz „Scroll depth” (to ustawienie projektu, nie kod).
- **Nie modyfikuj `proxy.ts` pod PostHog** — to Edge proxy (sesja Supabase). Wizard pisze „proxy.ts”, ale chodzi o **inny** typ aplikacji. U nas:
  - `new PostHog(token, { host })` → **`lib/analytics/posthog-node-client.ts`** (token z env)
  - `await client.shutdown()` → **`lib/analytics/posthog-process-shutdown.ts`** + **`instrumentation.ts`**
  - **Nigdy** nie commituj jawnego `phc_…` w plikach `.ts`

---

## 5. Szybki test

Po ustawieniu env i restarcie dev: wejdź na stronę, w DevTools → **Network** filtr `ingest` — powinny być żądania **200** do `http://localhost:3000/ingest/...`.

W PostHogu: **Activity** / **Live events** — ustaw zakres czasu na „Last 15 minutes” i upewnij się, że nie filtrujesz tylko produkcji (URL). Jeśli nadal pusto: w konsoli `localStorage.getItem('ff_analytics_consent')` — wartość `denied` blokuje capture (na prod zawsze; na dev też po „Tylko niezbędne”).

---

## 6. Wizard: „dodaj do proxy.ts” — mapowanie na ten projekt

| Krok z wizarda | Gdzie u nas | Uwagi |
|----------------|-------------|--------|
| `import { PostHog } from 'posthog-node'` | `lib/analytics/posthog-node-client.ts` | Nie w `proxy.ts` (Edge) |
| `const client = new PostHog('phc_…', { host })` | `getPostHogNodeClient()` + **env** | Token tylko w `.env.local` / Vercel |
| `process.on('SIGINT', () => client.shutdown())` | `lib/analytics/posthog-process-shutdown.ts` + `instrumentation.ts` | Już podpięte przy starcie serwera Node |

## 7. Node.js (`posthog-node`) — serwer

Odpowiednik dokumentacji PostHoga:

```js
import { PostHog } from 'posthog-node'

const client = new PostHog('[project token]', { host: 'https://eu.i.posthog.com' })
await client.shutdown()
```

**W projekcie:** jeden singleton + `shutdown` przy SIGTERM/SIGINT — plik **`lib/analytics/posthog-node-client.ts`**.

- **Token:** ten sam co w przeglądarce — `NEXT_PUBLIC_POSTHOG_KEY` w `.env.local` / Vercel (nie wklejasz literalu `phc_` do TS).
- **Host:** `NEXT_PUBLIC_POSTHOG_HOST` (domyślnie `https://eu.i.posthog.com`).
- **Wysyłka eventów:** `trackServer` / `identifyServer` w **`lib/analytics/server.ts`** (wołają `flush()` po każdej operacji — Vercel serverless).
- **Ręczny dostęp:** `getPostHogNodeClient()` albo `requirePostHogNodeClient()` z `posthog-node-client.ts` (albo legacy `getPostHogClient` z `lib/posthog-server.ts`).

`shutdownPostHogNodeClient()` jest podpięty w **`instrumentation.ts`** (`SIGTERM` / `SIGINT`).
