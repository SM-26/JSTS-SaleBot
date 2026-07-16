# --- Base Stage ---
FROM node:26-alpine AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./

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

# Install only production dependencies
RUN corepack enable && pnpm install --prod --frozen-lockfile

# Security: Run as a non-privileged user
USER node

CMD ["node", "dist/bot.js"]