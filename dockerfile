# --- Base Stage ---
FROM node:25-alpine AS base
WORKDIR /app
COPY package*.json ./

# --- Development Stage ---
FROM base AS development
RUN npm install
COPY . .
CMD ["npm", "run", "dev"]

# --- Build Stage ---
FROM base AS build
RUN npm ci
COPY . .
RUN npm run build

# --- Production Stage ---
FROM node:25-alpine AS production
# Set to production for optimization in some libraries (like Mongoose/Express)
ENV NODE_ENV=production
WORKDIR /app

# Only copy what is strictly necessary
COPY --from=build /app/package*.json ./
COPY --from=build /app/dist ./dist

# Install only production dependencies
RUN npm ci --omit=dev --quiet

# Security: Run as a non-privileged user
USER node

CMD ["node", "dist/bot.js"]