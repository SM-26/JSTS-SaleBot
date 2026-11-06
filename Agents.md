# Agents.md — JSTS-SaleBot

> This file provides guidance for AI coding agents (e.g. GitHub Copilot, Cursor, Claude) working on this repository.

---

## Project Overview

**JSTS-SaleBot** is a Telegram-based marketplace bot built with **TypeScript** (Node.js). It allows users to create sale posts directly inside Telegram, which are routed through a moderation group (new sellers) or published at once and reviewed afterwards (trusted sellers) in the approved sales channel/group. It supports post lifecycle management (pending → approved/rejected → sold/bumped) and admin runtime configuration.

**Stack:**
- Runtime: Node.js + TypeScript
- Telegram library: `node-telegram-bot-api` **v2.3.0** (middleware chain with `Context`, an `Api` taking params objects, `createSession`; imports come from `node-telegram-bot-api`, `node-telegram-bot-api/types` and `node-telegram-bot-api/node`)
- Database: MongoDB via `mongoose` (collections `posts`, `users`, plus `drafts` and `bot_sessions` for persistent flows)
- Linting: ESLint + `typescript-eslint`
- Infrastructure: Docker + Docker Compose (bot + MongoDB + mongo-express)

---

## Documentation

`docs/` is the source of truth, and it is copied to the [wiki](https://github.com/SM-26/JSTS-SaleBot/wiki) on every merge to master. Read the page before changing its area:

| Page | Covers |
|------|--------|
| [Architecture](docs/Architecture.md) | Where things are, post lifecycle, sessions and persistent flows, additive fields per slice |
| [Commands](docs/Commands.md) | Every command and who can use it |
| [Config](docs/Config.md) | Every `config.json` key |
| [Rollout](docs/Rollout.md) | Feature switches, what each sends, kill switches |
| [Running](docs/Running.md) | `.env`, compose stacks, deploy, blocked words |
| [Testing](docs/Testing.md) | Every `check-*` script, `MONGO_URI` setup |
| [Localization](docs/Localization.md) | Locale files, FAQ |
| [Moderating](docs/Moderating.md), [Selling](docs/Selling.md), [Buying](docs/Buying.md), [Catch-up](docs/Catch-up.md), [Backup](docs/BACKUP.md) | What moderators, members and the owner do |

Before opening a PR: `pnpm run lint`, `pnpm run build`, `pnpm test`. Never run the bot, or a check, against the production token or database.

`pnpm test` runs the checks in parallel (`src/tests/runAll.ts`), each Mongo script on its own database derived from `MONGO_URI`. In a check, wait for the bot with `idle()` from `src/tests/harness.ts` (proof that no update, fake Telegram call or MongoDB command is outstanding), never with a fixed `sleep`. Details in [Testing](docs/Testing.md).

---

## Agent Guidelines

### Do
- **Follow the existing service layer pattern**: business logic belongs in `src/services/`, database access in `src/repositories/`, type definitions in `src/types/index.ts`.
- **Enforce strict typing**: Avoid `any`. Use specific types from `node-telegram-bot-api` (e.g., `User`, `Message`, `CallbackQuery`) or define custom interfaces in `src/types/index.ts`.
- **Use `unknown` or Union Types**: If a type is truly dynamic (like translation parameters), prefer `Record<string, string | number | boolean>` or `unknown` over `any`.
- **Always update `src/locales/<lang>/common.json`** for all language keys when adding new user-facing messages. Validate with `pnpm run check-locals`.
- **Use the `BotConfig` type** when reading runtime configuration; never hardcode group IDs or language strings.
- **Tell the author once**: any path that notifies a post's author of a rejection must go through `postRepository.claimRejectionNotice`, so a double press or a restart never sends two notices.
- **Post layout by tier**: `PostService.formatPostRichMessage` takes `tier`/`stats` from `sellerLayout()` (publish, bump, sold edit). Regular is the original code and its golden must not change; the other layouts are pinned in `tierLayouts.golden.json` (`UPDATE_GOLDEN=1 pnpm run check-rich`, review the diff). `posts.layoutTier` is set only by the `/test` "Post as" cases.
- **Seller-post `/test` cases refuse outside the test bot** (`isTestBotToken`): they publish real posts, so never loosen that guard.
- **Persist flow state**: flows are persisted (drafts, sessions), so there is no `isIdle` flag. Before acting on a wizard message or button, read the user's draft (`draftRepository.findByUserId`) and check it exists, is not expired (`isDraftExpired`) and is at the expected step. On errors, tell the user and leave the draft consistent, so they can `/cancel` or continue.
- **Keep Mongoose queries in repositories**, not in services or controllers.
- **Use `async/await`** with `try/catch` for all async operations, logging errors with a `[ERROR - <context>]` prefix to `console.error`.
- **Avoid Conflicting Update Operators**: In MongoDB upsert operations (`findOneAndUpdate`), never include the same field path in both `$set` and `$setOnInsert`. This triggers a `ConflictingUpdateOperators` (Code 40) error.
- **Defensive Metadata Updates**: When updating user profiles, only `$set` fields that have valid, non-empty values from Telegram. Avoid overwriting existing database records with placeholder strings (like "Unknown") used during internal service discovery.
- **Preserve Docker targets** (`development`/`production`) when modifying the `dockerfile`.
- **Update Documentation**: A PR that changes behaviour updates its page in `docs/` in the same PR, plus `docs/CHANGELOG.md`. State each fact on one page and link to it; `pnpm run check-docs` fails on an undocumented command or config key and on a broken link. `docs/` is public: no private ids. Never edit the wiki by hand; it is overwritten.
- **Add Tests**: When implementing new logic or features, add an assertion to the matching `check-*` script (or a new one, wired into `pnpm test`), and a relevant case in `src/tests/testCases.ts` when it helps verify the behavior from Telegram.
- **Use v2 handler idioms**: register behavior as middleware in `registerRoutes()`, call the `Api` with a params object (`api.sendMessage({ chat_id, text })`), and detach genuinely long jobs (broadcasts, `/test` runs) so they never block the update loop or touch the session.

### Don't
- **Don't use `any`**: This project enforces the `@typescript-eslint/no-explicit-any` rule. Do not introduce new `any` declarations.
- **Don't add new config keys to `config.json`** without updating the `BotConfig` interface in `src/types/index.ts` and the `/config` handler in `adminService.ts`.
- **Don't hardcode strings in service files** — all text must come from `locals[config.lang]`.
- **Don't import directly from `src/tests/testCases.ts`** outside of `botController.ts` — test cases are intentionally isolated.
- **Don't bypass the moderation flow**: new sellers' posts pass through `moderationGroupId` before they appear in `approvedGroupId`. Trusted sellers' posts (an approved or sold post, no moderator take-down in the last 90 days) publish at once and are reviewed after publishing through the "Published (trusted seller)" card. Nothing else may publish to `approvedGroupId` without one of these two paths. Group listings (a member's own message, added through an opt-in capture note) are post-moderated instead: a seller's first listing of any kind (no listing yet, neither an approved bot post nor a group listing) sends a take-down card (`td_`) to the moderation topic. A seller can never remove an approved bot post (Sold is the way out): every `ls_` button is refused on a `bot` listing, and Remove on a group listing never touches the member's message. The bot posts nothing public for them. The one deliberate exception to "a member's own message is never touched" is a moderator's **Take down and delete original post** (`tx_`) on a group listing's take-down card: it ends the listing and deletes every id in `listing.messageIds` (photos included). It is moderators only and behind a confirm step; a seller's Remove still never deletes anything, and a bot listing's card has no such button. Catch-up offers (`/catchup`) reach no member before an admin runs `/catchup send`, and then only under `captureMode: optin`.
- **Don't change the `rr_<postId>_<n>`, `td_<listingId>`, `tx_<listingId>_<d|y|n>`, `mk_<captureId>_<a|n|x>`, `mk_set_ask` / `mk_set_never`, `ck_<memberId>_<x|messageId>` or `ls_<listingId>_<s|f|r>_<n|c|l>` callback formats**: they are frozen and pinned in `checkCallbackData.ts` (with `skip_reason_*`), and must stay within 64 bytes. Slice 5 adds `draft_edit_title_<userId>`, `draft_edit_price_<userId>`, `draft_edit_location_<userId>`, `draft_meetup_<userId>` and the `faq_1` start payload (the meeting-point button; it must keep opening FAQ node 1), frozen the same way. Slice 4 adds `al_<searchId>_<d|r>`, `lb_<id>_<u|d|m>` (buyer-match labels, next to `lb_<id>_<s|n|k>`) and the `s_<captureId>` start payload, frozen the same way. The `c_<id>` / `l_<id>` / `k_<memberId>` start payloads are pinned there too. The same goes for `lc_<r|s|x>_<listingId>` and `sc_go` / `sc_no`.
- **Don't use `var`**; prefer `const`/`let`. Follow the ESLint rules in `eslint.config.mjs`.
- **Don't keep per-user flow state in memory** (a `Map`, a module variable, a temporary listener): it is lost on restart.
- **Don't mutate `config.json` directly at runtime from code** — use `adminService` to handle `/config` updates.

- **An approved bot post ends only by Sold, expiry or take-down.** Never add a seller-facing way to remove one: `lc_x_` is refused on a `bot` listing and is not on its keyboards. Expiry changes the listing only; the post stays `approved`.
- **Nothing goes to a member unless `nudges` is on or the admin confirmed `/stalecheck`.**

### Adding a New Command
1. Add the handler method to an appropriate service (or create a new one in `src/services/`).
2. Register it in `BotController.registerRoutes()` in `src/controllers/botController.ts` with `cmd("name", handler)` (a thin wrapper over `command()` in `src/controllers/commands.ts`). Matching is anchored at the start of the message, case-insensitive, matches the exact command name, and accepts `/name` or `/name@ourbot` only; `/name@otherbot` is ignored. Pass `{ detached: true }` only for long jobs.
3. Add help strings to `src/locales/<lang>/common.json` for all languages and reference them in `showHelp()`.
4. Update the `/help` display in `botController.ts` if the command is user-facing, and add the command to `docs/Commands.md`.
5. Extend `src/tests/checkRoutes.ts` or `checkPlatform.ts` if the routing changes.

### Adding a New Locale
1. Create a new directory `src/locales/<lang>/` (e.g., `src/locales/ru/`).
2. Add a `common.json` file in the new directory, filling in all keys from `LocaleStrings`.
3. Run `pnpm run check-locals` — it will error on any missing keys.
4. Set `"lang": "<lang>"` in `config.json` to activate it as default (users can override with `/lang`).

