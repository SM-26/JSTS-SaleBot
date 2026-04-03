# Agents.md — JSTS-SaleBot

> This file provides guidance for AI coding agents (e.g. GitHub Copilot, Cursor, Claude) working on this repository.

---

## Project Overview

**JSTS-SaleBot** is a Telegram-based marketplace bot built with **TypeScript** (Node.js). It allows users to create sale posts directly inside Telegram, which are then routed through a moderation group before being published to an approved sales channel/group. It supports post lifecycle management (pending → approved/rejected → sold/bumped) and admin runtime configuration.

**Stack:**
- Runtime: Node.js + TypeScript
- Telegram library: `node-telegram-bot-api`
- Database: MongoDB via `mongoose`
- Linting: ESLint + `typescript-eslint`
- Infrastructure: Docker + Docker Compose (bot + MongoDB + mongo-express)

---

## Repository Structure

```text
/
├── src/
│   ├── bot.ts                    # Entry point: initializes DB, bot, registers routes
│   ├── config/
│   │   └── db.ts                 # Mongoose connection helper
│   ├── controllers/
│   │   └── botController.ts      # Main router: registers all Telegram command/callback handlers
│   ├── services/
│   │   ├── inputService.ts       # Prompts user for text, price, and media input via chat
│   │   ├── postService.ts        # Post formatting, preview, sending to groups, bump/sold editing
│   │   ├── moderationService.ts  # Approve/reject callback handling in moderation group
│   │   ├── myPostsService.ts     # /myposts listing, sold and bump callbacks
│   │   ├── adminService.ts       # /config command for runtime config edits
│   │   ├── photoService.ts       # Media (photo/video) file ID extraction helper
│   │   ├── userService.ts        # Ensures user record exists in DB on first interaction
│   │   └── paymentService.ts     # Donation invoice creation & payment event handling
│   ├── models/
│   │   ├── Post.ts               # Mongoose schema: Post (pending/approved/rejected/sold)
│   │   └── User.ts               # Mongoose schema: User (userId, username, isAdmin)
│   ├── repositories/
│   │   ├── postRepository.ts     # Post CRUD + status query helpers
│   │   └── userRepository.ts     # User lookup and admin-check helpers
│   ├── types/
│   │   └── index.ts              # Shared TypeScript interfaces (BotConfig, LocaleService, UserSession, etc.)
│   ├── tests/
│   │   ├── checkLocals.ts        # Validates locale keys are complete for src/locales
│   │   └── testCases.ts          # In-bot /test command suite (admin-only)
│   └locales/
│       ├── en/
│       │   └── common.json       # English locale strings
│       └── he/
│           └── common.json       # Hebrew locale strings
├── config.json.example           # Runtime config template (copy to config.json)
├── .env.example                  # Environment variable template (copy to .env)
├── dockerfile                    # Multi-stage Docker build (development + production targets)
├── docker-compose.yaml           # Bot + MongoDB + mongo-express services
├── tsconfig.json
├── eslint.config.mjs
└── package.json
```

---

## Configuration Files

### `.env`
Copy from `.env.example`. Required variables:
| Variable     | Description                          |
|--------------|--------------------------------------|
| `BOT_TOKEN`  | Telegram Bot API token from @BotFather |
| `MONGO_URI`  | MongoDB connection string             |

### `config.json`
Copy from `config.json.example`. Editable at runtime via `/config` (admin-only):

| Key                 | Type    | Description                                              |
|---------------------|---------|----------------------------------------------------------|
| `lang`              | string  | Default locale key from `src/locales/` (e.g. `"en"`)      |
| `moderationGroupId` | number  | Telegram group ID for the moderation channel             |
| `approvedGroupId`   | number  | Telegram group ID where approved posts are published     |
| `moderationTopicId` | number  | Forum topic ID within the moderation group (optional)    |
| `approvedTopicId`   | number  | Forum topic ID within the approved group (optional)      |
| `timeOut`           | number  | User input timeout in minutes                            |
| `validatePrice`     | boolean | Whether to enforce numeric price input                   |
| `minimumMedia`      | number  | Minimum number of photos/videos required per post        |
| `dailyBumpLimit`    | number  | Max number of bumps a user can perform per day per post  |

---

## Core Concepts

### Post Lifecycle
```
User sends /start
  → InputService collects: title, description, price, location, media
  → PostService shows preview
  → User confirms
  → Post saved to DB (status: "pending")
  → PostService forwards to moderation group
      → ModerationService: admin approves → status: "approved", posted to approved group
      → ModerationService: admin rejects  → status: "rejected", user notified
  → User can /myposts:
      → Mark as "sold"  → updates approved group message with sold tag
      → Bump post       → re-posts with updated timestamp (subject to dailyBumpLimit)
```

### Session Management
Each Telegram user has an in-memory `UserSession` (stored in a `Map<number, UserSession>` on `BotController`). The `isIdle` flag prevents overlapping conversations. Always check and reset `session.isIdle` around async flows.

### Localization
All user-facing strings live in `src/locales/<lang>/common.json` files, where `<lang>` is the language code (e.g., `en`, `he`). Each language has its own directory containing a `common.json` file with key-value pairs (matching `LocaleStrings` in `src/types/index.ts`). The `LocaleService` handles user-specific language preferences with fallback logic: `preferredLocale` → `languageCode` → default language. When adding new strings, update **every** language's `common.json` file and run `npm run check-locals` to validate completeness and syntax.

---

## Commands

| Command   | Access    | Description                                      |
|-----------|-----------|--------------------------------------------------|
| `/start`  | All users | Begins the post creation wizard                  |
| `/myposts`| All users | Lists user's own posts with bump/sold actions    |
| `/lang`   | All users | Change language preference                       |
| `/faq`    | All users | View airsoft FAQ and frequently asked questions  |
| `/help`   | All users | Shows available commands (admins see extra items)|
| `/config` | Admin     | View/update `config.json` keys at runtime        |
| `/test`   | Admin     | Runs in-bot test cases from `src/tests/testCases.ts` |
| `/donate` | All users | Donate Stars to support the bot (optional)       |

---

## Development Workflow

### Setup (local)
```bash
cp .env.example .env          # Fill in BOT_TOKEN and MONGO_URI
cp config.json.example config.json   # Adjust group IDs and settings
npm install
npm run dev                   # Runs via ts-node (no build required)
```

### Setup (Docker)
```bash
cp .env.example .env
cp config.json.example config.json
docker compose up --build
```
Mongo-express is available at `http://localhost:8081` for DB inspection.

### Build for production
```bash
npm run build    # Compiles TypeScript to dist/
npm start        # Runs dist/bot.js
```

### Linting & Testing
```bash
npm run lint         # ESLint check
npm run test         # Validates src/locales key completeness
```

---

## Agent Guidelines

### Do
- **Follow the existing service layer pattern**: business logic belongs in `src/services/`, database access in `src/repositories/`, type definitions in `src/types/index.ts`.
- **Always update `src/locales/<lang>/common.json`** for all language keys when adding new user-facing messages. Validate with `npm run check-locals`.
- **Use the `BotConfig` type** when reading runtime configuration; never hardcode group IDs or language strings.
- **Check `session.isIdle`** before starting any new async input flow, and always reset it (including in `catch` blocks) to prevent users getting stuck.
- **Keep Mongoose queries in repositories**, not in services or controllers.
- **Use `async/await`** with `try/catch` for all async operations, logging errors with a `[ERROR - <context>]` prefix to `console.error`.
- **Preserve Docker targets** (`development`/`production`) when modifying the `dockerfile`.
- **Update Documentation**: When implementing new features, always update `README.md` (Features list) and `CHANGELOG.md`.
- **Add Tests**: When implementing new logic or features, add a relevant test case in `src/tests/testCases.ts` to verify the behavior.

### Don't
- Don't add new config keys to `config.json` without updating the `BotConfig` interface in `src/types/index.ts` and the `/config` handler in `adminService.ts`.
- Don't hardcode strings in service files — all text must come from `locals[config.lang]`.
- Don't import directly from `src/tests/testCases.ts` outside of `botController.ts` — test cases are intentionally isolated.
- Don't bypass the moderation flow: posts must pass through `moderationGroupId` before appearing in `approvedGroupId`.
- Don't use `var`; prefer `const`/`let`. Follow the ESLint rules in `eslint.config.mjs`.
- Don't mutate `config.json` directly at runtime from code — use `adminService` to handle `/config` updates.

### Adding a New Command
1. Add the handler method to an appropriate service (or create a new one in `src/services/`).
2. Register the route in `BotController.registerRoutes()` in `src/controllers/botController.ts`.
3. Add help strings to `src/locales/<lang>/common.json` for all languages and reference them in `showHelp()`.
4. Update the `/help` display in `botController.ts` if the command is user-facing.

### Adding a New Locale
1. Create a new directory `src/locales/<lang>/` (e.g., `src/locales/ru/`).
2. Add a `common.json` file in the new directory, filling in all keys from `LocaleStrings`.
3. Run `npm run check-locals` — it will error on any missing keys.
4. Set `"lang": "<lang>"` in `config.json` to activate it as default (users can override with `/lang`).

---

## Key Files Quick Reference

| File | Purpose |
|------|---------|
| `src/bot.ts` | App entry point |
| `src/controllers/botController.ts` | All Telegram event routing |
| `src/services/inputService.ts` | Step-by-step user input collection |
| `src/services/postService.ts` | Post formatting & Telegram message management |
| `src/services/moderationService.ts` | Approve/reject logic |
| `src/services/myPostsService.ts` | User post management (bump, sold) |
| `src/services/adminService.ts` | Runtime config command |
| `src/services/paymentService.ts` | Handles Telegram Stars donations |
| `src/models/Post.ts` | Post Mongoose schema |
| `src/models/User.ts` | User Mongoose schema |
| `src/types/index.ts` | All shared TypeScript interfaces |
| `src/locales/` | Directory containing localized UI strings by language |
| `config.json` | Runtime bot configuration |
