# syntax=docker/dockerfile:1
# ═══════════════════════════════════════════════════════════════
# FaktWay — obraz produkcyjny pod Coolify/Hetzner (migracja M5).
#
# Multi-stage: deps → build → runner. Finalny obraz to standalone
# output Next.js (server.js + traced node_modules) — ~10× mniejszy
# niż pełny node_modules i bez narzędzi builda w runtime.
#
# Build lokalny (test):
#   docker build -t faktway --build-arg NEXT_PUBLIC_SUPABASE_URL=... .
# W Coolify: zmienne NEXT_PUBLIC_* oznacz jako "Build Variable" —
# są WYPIEKANE w bundlu JS podczas builda, nie czytane w runtime.
# ═══════════════════════════════════════════════════════════════

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# curl jest wymagany przez healthcheck Coolify: dla obrazów budowanych
# z Dockerfile'a Coolify odpytuje kontener właśnie `curl`em (lub `wget`em),
# a `node:22-slim` nie ma żadnego z nich — bez tego deploy kończy się
# statusem "unhealthy" i wycofaniem, mimo że proces działa poprawnie.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
# corepack czyta `packageManager` z package.json → dokładnie ta sama
# wersja pnpm co lokalnie i w CI.
RUN corepack enable

# ── deps: instalacja zależności (cache-owalna niezależnie od kodu) ──
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── build: next build --webpack w trybie standalone ──
FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Zmienne publiczne — inline'owane do bundla klienta podczas builda.
ARG NEXT_PUBLIC_APP_DOMAIN
ARG NEXT_PUBLIC_APP_ENV
ARG NEXT_PUBLIC_APP_URL
# Przełącznik wpuszczania telefonów do panelu (zob. lib/mobile-access.ts).
# Musi być build-argiem: proxy.ts idzie pod Edge, a tam Next wstawia
# wartości env w czasie budowania, nie odczytuje ich w locie.
ARG NEXT_PUBLIC_MOBILE_PANEL
ARG NEXT_PUBLIC_MOBILE_PANEL_ALLOWLIST
ARG NEXT_PUBLIC_POSTHOG_HOST
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
# Opcjonalny: source maps do GlitchTip/Sentry (build działa bez niego).
ARG SENTRY_AUTH_TOKEN
ENV NEXT_PUBLIC_APP_DOMAIN=$NEXT_PUBLIC_APP_DOMAIN \
    NEXT_PUBLIC_APP_ENV=$NEXT_PUBLIC_APP_ENV \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_MOBILE_PANEL=$NEXT_PUBLIC_MOBILE_PANEL \
    NEXT_PUBLIC_MOBILE_PANEL_ALLOWLIST=$NEXT_PUBLIC_MOBILE_PANEL_ALLOWLIST \
    NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST \
    NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    NEXT_PUBLIC_VAPID_PUBLIC_KEY=$NEXT_PUBLIC_VAPID_PUBLIC_KEY \
    SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN

ENV NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
# Node 22 domyślnie ogranicza sobie stertę do ~1958 MB niezależnie od realnie
# dostępnego RAM-u (sprawdzone: `v8.getHeapStatistics().heap_size_limit` na
# obrazie node:22-slim) — na `app-1` (CX23, 3.7 GB RAM) to za mało dla
# `next build --webpack` na tym rozmiarze apki.
#
# ⚠️ 3072 MB NIE MIEŚCI SIĘ W SAMYM RAM-ie — TEN BUILD JEDZIE NA SWAPIE.
# Poprzedni komentarz twierdził odwrotnie i był nieprawdziwy; kosztowało to
# wywalone wdrożenie 29 sierpnia 2026 (exit code 137, zabójca OOM).
# Rachunek na `app-1`: 3.7 GB fizycznie, z czego sam `dockerd` bierze ~775 MB,
# a działająca aplikacja, worker, `containerd`, `traefik` i proxy kolejne
# ~500 MB. Dla builda zostaje ~2.2 GB, czyli MNIEJ niż ten pułap.
#
# Zmierzone szczytowe zużycie swapu przy udanym buildzie: 4.5 GB — powyżej
# pierwotnych 4 GB. Dlatego `app-1` MUSI mieć co najmniej 8 GB swapu
# (dwa pliki po 4 GB, wpisane w `/etc/fstab`).
#
# Zanim obniżysz tę liczbę: 1958 MB (domyślne dla Node 22) było testowane
# i NIE WYSTARCZA. Zanim ją podniesiesz: patrz na swap, nie na RAM.
#
# 20.10.2026: 3072 → 3584 MB. Po ekranach Finory (#293–#295) build padł
# z „JavaScript heap out of memory” (exit 134 — pułap sterty, nie zabójca
# OOM) w kompilacji webpacka, przy serializacji map źródeł dla Sentry.
# Pomiar lokalny szczytu sterty kompilacji (Node 24, zawyża względem
# produkcji): wdrożony 67251ef6 3296 MB, main 4365 MB, main
# z `experimental.webpackMemoryOptimizations` (next.config.ts) 3526 MB.
# Optymalizacje + 3584 MB przechodzą lokalnie (także z E9). Swap app-1
# 20.10: 8 GB, w spoczynku zajęte ~1.6 GB — +512 MB sterty mieści się.
#
# 22.10.2026: 3584 → 4096 MB (decyzja Bartosza). Łatki bezpieczeństwa:
# Next 16.4.1 (GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r) i @sentry/nextjs
# 10.75.2 (GHSA-mchm-gjx6-7h55 — używamy `tunnelRoute`). Z nową wersją Sentry
# build padał przy 3584 MB nawet bez `widenClientFileUpload`; przy 4096 MB
# przechodzi (lokalnie szczyt RSS ~6.7 GB). Swap app-1 22.10: 8 GB, w spoczynku
# zajęte ~0.8 GB. Gdy build zginie z exit 137 — dołóż swap (pułapki w AGENTS.md).
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN pnpm build

# ── worker: proces jobów pg-boss (Etap 7 migracji Hetzner) ──
# Drugi kontener z TEGO SAMEGO repo — w Coolify osobna aplikacja z
# `Dockerfile target: worker` (kolumna dockerfile_target_build).
# Celowo pełne node_modules + tsx zamiast standalone: worker importuje
# szeroki przekrój lib/** (joby, e-maile React Email, XSD/WASM), a rozmiar
# obrazu na własnym serwerze nie jest krytyczny.
FROM base AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# AUD-127: proces bez roota. Obraz `node` ma użytkownika `node`; pliki aplikacji
# zostają tylko do odczytu, a zapisy (tsx, eksporty) idą do /tmp.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||8080)+'/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
# `server-only-hook.mjs`: moduły z `import 'server-only'` rzucają poza warunkiem
# `react-server`, więc hak podmienia sam `server-only` na pusty moduł. NIE wracaj
# do globalnego `--conditions=react-server`: psuje `react-dom/server` i render
# maili (RUN-01). Ten sam ciąg ma `worker:dev` — pilnuje tego test
# tests/unit/worker-start-jak-dockerfile.test.ts.
CMD ["node", "--import", "./lib/jobs/server-only-hook.mjs", "--import", "tsx", "lib/jobs/worker.ts"]

# ── runner: minimalny obraz produkcyjny ──
# MUSI zostać ostatnim etapem pliku: `docker build` bez `--target` buduje
# etap ostatni, więc każdy build bez jawnego targetu ma dać aplikację webową,
# a nie workera. (Odwrotna kolejność raz już wyłączyła produkcję.)
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Jak w etapie `base` — healthcheck Coolify potrzebuje curla.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# Proces bez roota — standard bezpieczeństwa kontenerów.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# Coolify ma własny healthcheck (ustaw ścieżkę /api/health w UI),
# ale wbudowany fallback nie zaszkodzi przy `docker run` bez Coolify.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
