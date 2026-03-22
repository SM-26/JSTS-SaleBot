# --- Base Stage ---
FROM node:25-alpine AS base
WORKDIR /app
COPY package*.json ./

# --- Development Stage ---
FROM base AS development
# Using install here is fine for dev as you might add packages frequently
RUN npm install
COPY . .
CMD ["npm", "run", "dev"]

# --- Build Stage ---
FROM base AS build
# ci is faster and more reliable for automated builds
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
RUN npm ci --omit=dev

# Security: Run as a non-privileged user
USER node

CMD ["node", "dist/bot.js"]