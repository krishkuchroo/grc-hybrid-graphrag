# The front door image (D60): Caddy with the built web app and the Caddyfile baked in.
# Built from the repo root (packages/infra/compose.yaml sets the context).
FROM node:24-bookworm-slim AS web
RUN npm install -g pnpm@11.1.3
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @grc/web... && pnpm --filter @grc/web build

FROM caddy:2.11.4-alpine
COPY packages/infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /app/packages/web/dist /srv
