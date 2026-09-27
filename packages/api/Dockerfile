# One image for both programs (D36): grc-api and grc-worker differ only in their start command,
# which the compose file sets. Built from the repo root (packages/infra/compose.yaml sets the context).
FROM node:24-bookworm-slim

RUN npm install -g pnpm@11.1.3

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && chown -R node:node /app

USER node
