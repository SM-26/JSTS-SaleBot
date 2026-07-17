# --- Base Stage ---
FROM node:26-alpine AS base
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# node:26 no longer bundles Corepack, so install pnpm directly — pinned to the
# "packageManager" field in package.json so Docker, CI and local never drift.
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"

# --- Development Stage ---
FROM base AS development
RUN pnpm install --frozen-lockfile
COPY . .
CMD ["pnpm", "run", "dev"]

# --- Build Stage ---
FROM base AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# --- Production Stage ---
FROM node:26-alpine AS production
# Set to production for optimization in some libraries (like Mongoose/Express)
ENV NODE_ENV=production
WORKDIR /app

# Only copy what is strictly necessary
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/dist ./dist
# Locales are read from disk at runtime (process.cwd()/src/locales) and tsc only
# emits .js, so the JSON has to be copied in explicitly or every string falls
# back to its raw key. config.json is NOT baked in — mount it at /app/config.json.
COPY --from=build /app/src/locales ./src/locales

# Install only production dependencies (same pinned pnpm as the base stage)
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" \
    && pnpm install --prod --frozen-lockfile

# Security: Run as a non-privileged user
USER node

CMD ["node", "dist/bot.js"]