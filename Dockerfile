# ─────────────────────────────────────────────────────────
# Stage 1 — Build
# ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .

RUN npx prisma generate
RUN yarn build

# ─────────────────────────────────────────────────────────
# Stage 2 — Runtime
# ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Default to production. ECS task definitions override this per environment
# (e.g. NODE_ENV=staging for the staging task). NODE_ENV is the single source
# of truth for environment — Sentry, logging, and sample rates all read it.
ENV NODE_ENV=production

# Only production dependencies
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

# Copy built output and Prisma artifacts
COPY --from=builder /app/dist            ./dist
COPY --from=builder /app/node_modules/.prisma  ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma  ./node_modules/@prisma
COPY --from=builder /app/prisma          ./prisma

EXPOSE 3000

# Runs DB migrations on every container start, then launches the app.
# Safe because `migrate deploy` is idempotent — skips already-applied migrations.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main"]
