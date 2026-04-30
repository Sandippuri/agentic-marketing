FROM node:20-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/manager/package.json apps/manager/
COPY packages/ packages/
RUN pnpm install --frozen-lockfile

FROM base AS runtime
COPY --from=deps /app /app
COPY apps/manager apps/manager
WORKDIR /app/apps/manager
CMD ["pnpm", "start"]
