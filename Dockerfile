# The runtime is pinned here, not in package.json's engines field. engines
# states a floor so a too-old Node fails loudly; this line is what actually
# runs in production, and it is exact so two deploys a month apart are the
# same runtime.
FROM node:22.14-alpine AS base

# npm, pinned to the version that writes the lockfile.
#
# node:22.14-alpine bundles npm 10.9.2, and this repo's lockfile is written
# by npm 11. The two resolve dependency trees differently, so `npm ci` under
# 10 rejected a lockfile that 11 considers correct — the first Railway build
# failed exactly this way, on packages nobody added by hand (@solana/kit,
# zod, @emnapi/*) that are transitive deps of Reown's adapters.
#
# Pinning here rather than loosening `npm ci` to `npm install`: the whole
# value of `ci` is that the build installs precisely what was committed.
ARG NPM_VERSION=11.6.2

# --- dependencies -----------------------------------------------------
FROM base AS deps
# sharp normalises uploaded images and ships prebuilt binaries; libc6-compat
# is what lets those load on Alpine's musl.
RUN apk add --no-cache libc6-compat
ARG NPM_VERSION
RUN npm i -g npm@${NPM_VERSION}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- build ------------------------------------------------------------
FROM base AS builder
ARG NPM_VERSION
RUN npm i -g npm@${NPM_VERSION}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so
# they have to be present here rather than only at run time. Railway passes
# build args through from the service variables.
ARG NEXT_PUBLIC_ARC_RPC_URL
ARG NEXT_PUBLIC_REOWN_PROJECT_ID
ARG NEXT_PUBLIC_PINATA_GATEWAY
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- runtime ----------------------------------------------------------
FROM base AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Not root. A container that only needs to read its own bundle and open a
# socket has no reason to be able to write to it.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
# Railway assigns the port; standalone's server reads PORT.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
