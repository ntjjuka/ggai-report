# syntax=docker/dockerfile:1.7
# 두 타깃: web (Next standalone) · worker (tsx로 TypeScript 직접 실행)
FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache libc6-compat
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# 빌드 시점엔 DB·키가 필요 없다 (모든 페이지가 동적 렌더)
RUN pnpm next build

# ── web ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
CMD ["node", "server.js"]

# ── worker ────────────────────────────────────────────────────────────
FROM deps AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY tsconfig.json next.config.ts ./
COPY src ./src
COPY db ./db
COPY public/fonts ./public/fonts
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
CMD ["node_modules/.bin/tsx", "src/worker/index.ts"]
