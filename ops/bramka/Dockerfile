# Bramka FaktWay (B-2) — osobny, mały obraz: bez kodu aplikacji, bez kluczy
# service_role. Coolify: aplikacja na ops-1, Base Directory `/ops/bramka`,
# Dockerfile `/Dockerfile`, bez portów i domen. docs/runbooks/bramka-telegram.md
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && pnpm install --frozen-lockfile --prod --ignore-scripts \
  && pnpm store prune

COPY main.mjs ./
COPY src ./src

USER node
CMD ["node", "main.mjs"]
