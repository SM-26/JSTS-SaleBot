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

## Repository Structure

```text
/
├── src/
│   ├── bot.ts                    # Entry point: initializes DB, bot, registers routes
│   ├── config/
│   │   ├── db.ts                 # Mongoose connection helper
│   │   ├── pollingErrors.ts      # Polling error classification / de-duplicated logging
│   │   └── blockedWords.json     # Built-in blocked-word list (editable on the host, see docs/README.md)
│   ├── controllers/
│   │   ├── botController.ts      # Main router: registerRoutes() builds the v2 middleware chain
│   │   ├── commands.ts           # command(): anchored, case-insensitive matcher, @ourbot only
│   │   ├── middleware.ts         # ensureUser, sessionKey, requireAuthLevel, errorBoundary, staleButtonCatchAll
│   │   └── callbackRoutes.ts     # callback_data prefix → action; formats are frozen (golden test)
│   ├── services/
│   │   ├── inputService.ts       # Wizard prompts (step indicator) and price validation
│   │   ├── wizardService.ts      # /newPost wizard as a step machine over drafts; /cancel; wizard buttons
│   │   ├── postService.ts        # Post formatting, preview, sending to groups, bump/sold editing
│   │   ├── moderationService.ts  # Approve/reject callbacks; reject presets (rr_) or reply (legacy Skip still works); once-only author notice
│   │   ├── publishService.ts     # submitPost(): trusted sellers publish at once with a review card, others go to moderation
│   │   ├── trustService.ts       # isTrustedSeller(): approved or sold post, no moderator take-down in 90 days; sellerTier()/sellerLayout(): regular/top/verified/both
│   │   ├── tierLayouts.ts        # Rich post layouts for top, verified and both sellers (regular stays in postService)
│   │   ├── takeDownService.ts    # Moderator take-down (td_): listing taken_down, group message removed, author told; tx_ also deletes a group listing's original post (confirm step)
│   │   ├── myPostsService.ts     # /myposts listing, sold and bump callbacks
│   │   ├── adminService.ts       # /config command for runtime config edits
│   │   ├── userService.ts        # Ensures user record exists in DB on first interaction
│   │   ├── paymentService.ts     # Donation invoice creation & payment event handling
│   │   ├── classifier.ts         # Pure classifier: tier (strict/ask/wtb/none), rules, parsed title/price, text hash
│   │   ├── classifierData.json   # Classifier word lists and aliases (data only)
│   │   ├── blockedWords.ts       # Blocked-word matcher, re-read from disk within ~60 s
│   │   ├── captureService.ts     # Records sale-topic messages into capture windows (silent)
│   │   ├── shadowService.ts      # tick(): close windows, classify, write shadow_log rows
│   │   ├── matchService.ts       # Ranks live listings for a "wanted" message
│   │   ├── marketService.ts      # Reconciles bot posts into listings (LEGACY_CUTOFF)
│   │   ├── sweeper.ts            # Overlap-free interval jobs (10 s capture tick, hourly reconcile)
│   │   ├── shadowAdminService.ts # /label and /stats
│   │   ├── buyerNoteService.ts   # Private buyer note on a "wanted" post: matching listings, Alert me link (s_)
│   │   ├── buyerCards.ts         # Pure card builders for the buyer note, /alerts list, alert DMs; al_ helpers
│   │   ├── savedSearchService.ts # /alerts, the s_ start link, the one-reply fix (pendingAlertFix), al_ buttons
│   │   ├── alertService.ts       # Sweeper job: DM new matches for saved searches, renewal offers
│   │   ├── meetup.ts             # Beit Dagan meeting point: isMeetupLocation, meetupLocationText, the faq_1 link and button
│   │   ├── captureNoteService.ts # Private opt-in capture notes: ask/refresh, Add / Not now / Don't ask again (mk_)
│   │   ├── lifecycleService.ts   # Refresh / sold / remove for any listing (lc_), 7-day nudge, 30-day expiry, held nudges
│   │   ├── staleCheckService.ts  # /stalecheck: ask legacy sellers if a listing is still for sale (sc_)
│   │   ├── groupListingService.ts # Group listings: Add, Sold/Refresh/Remove (ls_), edit sync, /myposts section
│   │   ├── listingCards.ts       # Pure card builders and the mk_/ls_/start-payload helpers
│   │   ├── ephemeralNotes.ts     # The only caller of the ephemeral Bot API methods (send/edit/delete a note)
│   │   └── deepLinks.ts          # start=c_/l_ payload parser, bot and group message links
│   ├── models/
│   │   ├── Post.ts               # Mongoose schema: Post (pending/approved/rejected/sold)
│   │   ├── User.ts               # Mongoose schema: User (userId, username, authLevel)
│   │   ├── Draft.ts              # Mongoose schema: Draft (one /newPost wizard per user; collection `drafts`)
│   │   ├── Listing.ts            # Mongoose schema: Listing (bot post or group message; collection `listings`)
│   │   ├── Capture.ts            # Mongoose schema: Capture (sale-topic posting window; collection `captures`, 7-day TTL)
│   │   ├── ShadowLog.ts          # Mongoose schema: ShadowLog (what capture would have done; `shadow_log`, 120-day TTL)
│   │   ├── Member.ts             # Mongoose schema: Member (last seen; collection `members`)
│   │   ├── SavedSearch.ts        # Mongoose schema: SavedSearch (a buyer's parsed query; `saved_searches`, 60-day TTL)
│   │   └── AlertLog.ts           # Mongoose schema: AlertLog (one row per search and listing alerted; `alert_log`)
│   ├── repositories/
│   │   ├── postRepository.ts     # Post CRUD + status query helpers
│   │   ├── userRepository.ts     # User lookup and auth-level helpers
│   │   ├── draftRepository.ts    # Draft CRUD, atomic pushMedia/claim, isDraftExpired (against timeOut)
│   │   ├── sessionStore.ts       # MongoSessionStore: v2 session store (collection `bot_sessions`)
│   │   ├── listingRepository.ts  # Listing upserts, seller lookups, matching candidates
│   │   ├── captureRepository.ts  # Capture windows: atomic append, close and classify claims
│   │   ├── shadowLogRepository.ts # Shadow log rows, labels, stats
│   │   ├── memberRepository.ts   # Member last-seen touches
│   │   ├── savedSearchRepository.ts # Saved searches: upsert, per-buyer cap, due scans and renewals
│   │   └── alertLogRepository.ts # Alert send-once claim and failure marks
│   ├── types/
│   │   └── index.ts              # Shared TypeScript interfaces (BotConfig, LocaleService, UserSession, etc.)
│   ├── tests/
│   │   ├── check*.ts, *.check.ts # The `pnpm run check-*` scripts (see Linting & Testing)
│   │   ├── harness.ts            # Offline bot harness (fake fetch) shared by the checks
│   │   ├── fixtures.ts           # seedCapture(): a classified capture straight through the model
│   │   ├── checkListingCards.ts  # `pnpm run check-cards`: card builders, mk_/ls_ formats, start payloads
│   │   ├── syntheticCapture.ts   # Manual (not in `pnpm test`): 20 messages through the controller on the TEST bot/group
│   │   ├── lifecycleFakes.ts     # Fakes for the lifecycle checks
│   │   ├── syntheticLifecycle.ts # Manual (not in `pnpm test`): a stale-check DM and a nudge DM to the owner on the TEST bot
│   │   ├── syntheticOptin.ts     # Manual (not in `pnpm test`): one real private note + one moderation card on the TEST bot/groups, cleaned up after
│   │   ├── checkBuyerMatches.ts  # `pnpm run check-buyer`: saved searches, alerts, buyer notes
│   │   ├── quickListingChecks.ts # quickListing and meeting-point checks, run from checkFlows
│   │   ├── syntheticBuyer.ts     # Manual (not in `pnpm test`): one buyer note and one alert on the TEST bot/groups, cleaned up after
│   │   └── testCases.ts          # In-bot /test command suite (admin-only)
│   └locales/
│       ├── en/
│       │   └── common.json       # English locale strings
│       ├── he/
│       │   └── common.json       # Hebrew locale strings
│       └── ru/
│           └── common.json       # Russian locale strings
├── scripts/
│   └── census.js                 # Read-only mongosh DB census (see docs/BACKUP.md)
├── config.json.example           # Runtime config template (copy to config.json)
├── config.test.json.example      # Config for compose.test.yaml (test groups, every feature on)
├── .env.example                  # Environment variable template (copy to .env)
├── dockerfile                    # Multi-stage Docker build (development + production targets)
├── docker-compose.yaml           # Dev stack: bot + MongoDB + mongo-express services
├── compose.prod.yaml             # Production stack: pulls the GHCR image, ports bound to 127.0.0.1
├── compose.test.yaml             # Local test stack (test bot, own database), for Docker Desktop
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
| `timeOut`           | number  | Minutes of inactivity before a wizard draft expires (0 = never); read live on every touch |
| `validatePrice`     | boolean | Whether to enforce numeric price input                   |
| `minimumPhotos`     | number  | Minimum number of photos/videos required per post (0 = optional) |
| `mediaLayout`       | string  | How multiple photos render: `"slideshow"` or `"collage"`  |
| `dailyBumpLimit`    | number  | Max number of bumps a user can perform per day per post  |
| `captureMode`       | string  | `"off"` or `"shadow"`: record and classify sale-topic messages, send nothing. Code default `off`; `config.json.example` ships `shadow` |
| `buyerMatches`      | string  | `"off"`, `"shadow"` or `"on"`: `shadow` logs the listings a "wanted" message would match; `on` also sends the buyer notes and saved-search alerts (`shadow` is the kill switch: saved searches stay and resume, except that a 403 deletes that buyer's searches, and the 60-day TTL still applies). Code default `off`; `config.json.example` ships `shadow` |
| `quickListing`      | boolean | `true` lets a captioned photo, video or album in DM start a draft, adds field-edit buttons and the Beit Dagan toggle to previews, and handles `/start sell`. Default `false`: the wizard behaves as before |
| `nudges`            | boolean | `true` sends the 7-day refresh nudge (default `false`); expiry at 30 days runs regardless |
| `rulesUrl`          | string  | `https://t.me/` link to the group rules (empty = none); adds a "Group rules" button to reject messages |

---

## Core Concepts

### Post Lifecycle
```
User sends /newPost (or, with config.quickListing, a photo/video/album with a caption in DM and no draft:
                       a quick draft is built from the caption; album items are collected, preview 1.5 s after the last;
                       a wanted caption gets matches (buyerMatches on) or a one-line pointer instead; missing title/price/minimumPhotos go to that wizard step)
  → WizardService walks the user's draft (collection `drafts`): title, description, price, location, media
  → PostService shows preview
      (blocked words, including those in hidden link URLs, are stopped here, for everyone, trusted sellers included)
      (with quickListing every preview has edit buttons and the Beit Dagan meetup toggle; `meetup` shows
       as `📍 location · בית דגן`, and the words of the place in a post's location line link to start=faq_1)
  → User confirms
  → Post saved to DB (status: "pending")
  → PublishService.submitPost:
      → trusted seller (approved or sold post, no moderator take-down in 90 days)
          → status: "approved", posted to approved group at once; the moderation group gets a
            "Published (trusted seller)" card with Take down, reviewed after publishing
      → new seller → PostService forwards to moderation group
      → ModerationService: admin approves → status: "approved", posted to approved group (card has Take down when its listing exists)
      → ModerationService: admin rejects  → status: "rejected"; the moderator picks a preset reason (rr_),
                                            or REPLIES to the prompt (old Skip buttons still work); the user is notified
                                            exactly once (claimRejectionNotice), with "Fix and resend" and the rules link
      → TakeDownService: moderator takes down a published post (td_) → listing "taken_down", group message
                         removed, author told, trust revoked for 90 days; the post can no longer be bumped or sold
  → User can /myposts:
      → Mark as "sold"  → updates approved group message with sold tag
      → Bump post       → re-posts with updated timestamp (subject to dailyBumpLimit)
  → LifecycleService (listings, not posts): 7 days without refresh → nudge DM (only with config.nudges);
      30 days → listing "expired" (always; the approved bot post stays "approved", its group message is untouched);
      /myposts offers Relist on an expired bot listing; the admin's /stalecheck asks legacy (hold) sellers once
```

### Session Management and Persistent Flows
Nothing a user or moderator is in the middle of lives in process memory: a restart must lose nothing. There is no in-memory session map and no `isIdle` flag.
- **Wizard state** lives in the `drafts` collection (`Draft` model, `draftRepository`): one document per user with the step, the answers, the media and `promptMessageId`. `WizardService` reads the user's draft on every update. Wizard buttons (Done-media, Confirm, Cancel, Continue/Start over) are valid only against the draft itself: it exists, its step matches and the pressed message is `promptMessageId`. Anything else falls through to `staleButtonCatchAll`, which answers "expired".
- **Quick drafts** (`quickListing`): the draft also holds `quick`, `collecting`, `mediaGroupId` and `caption`. An album's items are appended atomically; a per-user in-memory timer (user id only) sends the preview 1.5 s after the last item, and a restart loses only that send (`/newpost` then Continue resends).
- **Expiry**: `isDraftExpired(draft, config.timeOut)` is checked on every touch against the live `timeOut` (minutes, 0 = never). There is deliberately no TTL index; startup deletes drafts already past `timeOut`.
- **v2 sessions** (`createSession` in `BotController`, backed by `MongoSessionStore`, collection `bot_sessions`) are keyed `chat:user` (`sessionKey()`) with a 3-day idle TTL. They hold only the donation custom-amount flag, the moderator's pending reject-reason prompts (`pendingRejects`), a buyer's one-reply fix for a thin `/alerts` text (`pendingAlertFix`: prompt message id and time, valid 1 hour; with a `searchId` it replaces that search) and the admin's pending `/stalecheck` send (`pendingStalecheck`, tied to its dry-run message by `promptMessageId`). Reject prompts use v2 `expectReply`/`expectCallback` markers keyed on the prompt message id.
- **Slice 1 fields** (`posts.rejectionNotifiedAt`, `drafts.fixing`) are optional and additive: the 2.0.1 image ignores them. `fixing` marks a wizard re-asking one field after a blocked word.
- **Market collections** (`listings`, `captures` with a 7-day TTL, `shadow_log` with a 120-day TTL, `members`) are additive like the two above: v1 ignores them, nothing in `posts`/`users` changed, and rolling back to the 2.0.1 image against the same database still works (the new collections are harmless leftovers). Capture windows are rows in `captures` (90 s window, closed after 30 s of quiet), advanced by the sweeper started in `bot.ts`; there is no in-memory window state.
- **Session data** also holds `pendingStalecheck` (the admin's pending `/stalecheck` dry run, confirmed with `sc_go` or dropped with `sc_no`).
- **Slice 2 fields** are optional and additive too: `captures.note.kind` (`ask`/`refresh`; both count toward the 3 notes per seller per 24 h), `members.declined` (hash and date of every text a note was sent for, answered or not, kept 30 days, 20 hashes max, so a member is never nagged about the same text) and `drafts.captureId` (a `/start c_` draft prefilled from a capture). `/start c_` refuses to overwrite a live draft, and nothing else creates capture drafts, because an older image's wizard would post one as a bot post. After a rollback the `mk_`/`ls_` buttons do nothing and `/myposts` does not show group listings.
- **Slice 5 fields** are optional and additive: `drafts.quick`, `drafts.collecting`, `drafts.mediaGroupId`, `drafts.caption` and `meetup` on `drafts`, `posts` and `listings`. The album preview timer is in memory and holds only the user id: a restart loses only the send, and `/newpost` then Continue resends (the draft is in Mongo, `claimCollecting` is the guard). After a rollback to 3.1.0 the fields are ignored and the `draft_edit_*` / `draft_meetup_*` buttons answer as stale.
- **Slice 4 fields** are optional and additive: new collections `saved_searches` (60-day TTL on `expiresAt`, in every mode) and `alert_log` (unique per search and listing), plus `shadow_log.matchLabel*`, `shadow_log.buyerNoteAt`, `members.lastBuyerNoteAt` and `listings.meetup`. A saved search holds the parsed query, never the original message; it stays and resumes when `buyerMatches` goes back to `on`, except that a 403 (the buyer blocked the bot) deletes that buyer's searches, and the 60-day TTL deletes the rest. After a rollback the `al_` buttons answer "expired" and `s_` links fall to the greeting.
- **Slice 3 fields** are optional and additive: `listings.nudgeHeld` (a nudge was claimed but could not be delivered; it waits for the seller's next sale-topic message) and `listings.staleSentAt` (set by `/stalecheck`, starts the 7-day answer window). `posts` and `users` are unchanged. After a rollback to 3.1.0 the `lc_`/`sc_` buttons do nothing and nothing expires or nudges; the fields are ignored.
- A new multi-step flow stores its state in a document or in session data, never in an in-memory `Map`. `drafts` and `bot_sessions` are additive: keep their documents backward-compatible, and never change existing `posts`/`users` fields without a migration plan (see `docs/BACKUP.md`).

### Localization
All user-facing strings live in `src/locales/<lang>/common.json` files, where `<lang>` is the language code (e.g., `en`, `he`). Each language has its own directory containing a `common.json` file with key-value pairs (matching `LocaleStrings` in `src/types/index.ts`). The `LocaleService` handles user-specific language preferences with fallback logic: `preferredLocale` → `languageCode` → default language. When adding new strings, update **every** language's `common.json` file and run `pnpm run check-locals` to validate completeness and syntax.

---

## Commands

| Command   | Access    | Description                                      |
|-----------|-----------|--------------------------------------------------|
| `/start`  | All users | Shows a welcome greeting                          |
| `/newPost`| All users | Begins the post creation wizard (Continue / Start over if a draft exists) |
| `/cancel` | All users | Drops your wizard draft; in the moderation group, forgets your pending reject-reason prompts |
| `/myposts`| All users | Lists user's own posts with bump/sold actions    |
| `/lang`   | All users | Change language preference                       |
| `/faq`    | All users | View airsoft FAQ and frequently asked questions  |
| `/help`   | All users | Shows available commands (admins see extra items)|
| `/config` | Admin     | View/update `config.json` keys at runtime        |
| `/stalecheck` | Admin | DM only: dry run, then ask legacy-listing sellers if each is still for sale (`sc_go`/`sc_no`) |
| `/label`  | Admin     | DM only: label a random would-list shadow row as sale / not sale |
| `/stats`  | Mod       | DM only: shadow classifier numbers (tiers, merges, label precision) |
| `/alerts` | All users | `/alerts <text>` saves a search for what you want to buy; `/alerts` lists, removes and renews them (saving needs `buyerMatches: on`; listing and the buttons work in every mode) |
| `/verify`, `/unverify` | Admin | Set or clear the ✅ verified mark (`users.verifiedAt`); tiers pick the post layout |
| `/test`   | Admin     | Runs in-bot test cases from `src/tests/testCases.ts` |
| `/donate` | All users | Donate Stars to support the bot (optional)       |

---

## Development Workflow

### Setup (local)
```bash
cp .env.example .env          # Fill in BOT_TOKEN and MONGO_URI
cp config.json.example config.json   # Adjust group IDs and settings
pnpm install
pnpm run dev                   # Runs via ts-node (no build required)
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
pnpm run build    # Compiles TypeScript to dist/
pnpm start        # Runs dist/bot.js
```

### Linting & Testing
```bash
pnpm run lint            # ESLint check
pnpm run build           # tsc type check
pnpm run test            # runs every check-* script below, in this order
```

| Script | What it checks | Needs `MONGO_URI` |
|--------|----------------|------------------|
| `pnpm run check-locals` | Locale files: JSON syntax, no empty values, key parity across `en`/`he`/`ru`, FAQ structure | no |
| `pnpm run check-config` | `/config` value parsing per key (`configSchema`) | no |
| `pnpm run check-classifier` | Classifier fixtures: tiers, price/title parsing, blocked words | no |
| `pnpm run check-claim` | Atomic approve/reject claim under concurrency | yes |
| `pnpm run check-polling` | Polling-error classification and de-duplication | no |
| `pnpm run check-callbacks` | Golden test pinning every `callback_data` format | no |
| `pnpm run check-cards` | Listing and note card builders, `mk_`/`ls_` callback_data and `start=c_`/`l_` payload formats | no |
| `pnpm run check-platform` | Command matcher and middleware (offline harness) | no |
| `pnpm run check-store` | `MongoSessionStore` (TTL, expiry on read) | yes |
| `pnpm run check-routes` | Route smoke test through the middleware chain | yes |
| `pnpm run check-flows` | Wizard and reject-reason flows, including a simulated restart | yes |
| `pnpm run check-market` | Market collections, indexes, capture windows, sweeper, WTB ranking, shadow pipeline | yes |
| `pnpm run check-buyer` | Buyer notes, saved searches, alert sweep and send-once claim, `/label` matches | yes |
| `pnpm run check-tiers` | Tier selection, /verify permissions, tier layouts at publish/sold, /test tier cases | yes |
| `pnpm run check-rich` | Rich-message builders: help, broadcast report, post entities (golden strings) | no |

The Mongo-gated checks print `[SKIP]` and pass when `MONGO_URI` is unset, so a green local run without it is not full coverage. Point it at a throwaway database, never production, e.g. `docker run -d --rm --name test-mongo -p 127.0.0.1:27028:27017 mongo:8.2` and `MONGO_URI=mongodb://127.0.0.1:27028/SalesBotTestDB pnpm test`. The checks also need a `config.json` (`cp config.json.example config.json`). CI provides both.

Never run the bot, or a check, against the production token or database.

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
- **Update Documentation**: When implementing new features, always update `README.md` (Features list) and `CHANGELOG.md`.
- **Add Tests**: When implementing new logic or features, add an assertion to the matching `check-*` script (or a new one, wired into `pnpm test`), and a relevant case in `src/tests/testCases.ts` when it helps verify the behavior from Telegram.
- **Use v2 handler idioms**: register behavior as middleware in `registerRoutes()`, call the `Api` with a params object (`api.sendMessage({ chat_id, text })`), and detach genuinely long jobs (broadcasts, `/test` runs) so they never block the update loop or touch the session.

### Don't
- **Don't use `any`**: This project enforces the `@typescript-eslint/no-explicit-any` rule. Do not introduce new `any` declarations.
- **Don't add new config keys to `config.json`** without updating the `BotConfig` interface in `src/types/index.ts` and the `/config` handler in `adminService.ts`.
- **Don't hardcode strings in service files** — all text must come from `locals[config.lang]`.
- **Don't import directly from `src/tests/testCases.ts`** outside of `botController.ts` — test cases are intentionally isolated.
- **Don't bypass the moderation flow**: new sellers' posts pass through `moderationGroupId` before they appear in `approvedGroupId`. Trusted sellers' posts (an approved or sold post, no moderator take-down in the last 90 days) publish at once and are reviewed after publishing through the "Published (trusted seller)" card. Nothing else may publish to `approvedGroupId` without one of these two paths. Group listings (a member's own message, added through an opt-in capture note) are post-moderated instead: a seller's first listing of any kind (no listing yet, neither an approved bot post nor a group listing) sends a take-down card (`td_`) to the moderation topic. A seller can never remove an approved bot post (Sold is the way out): every `ls_` button is refused on a `bot` listing, and Remove on a group listing never touches the member's message. The bot posts nothing public for them. The one deliberate exception to "a member's own message is never touched" is a moderator's **Take down and delete original post** (`tx_`) on a group listing's take-down card: it ends the listing and deletes every id in `listing.messageIds` (photos included). It is moderators only and behind a confirm step; a seller's Remove still never deletes anything, and a bot listing's card has no such button.
- **Don't change the `rr_<postId>_<n>`, `td_<listingId>`, `tx_<listingId>_<d|y|n>`, `mk_<captureId>_<a|n|x>`, `mk_set_ask` / `mk_set_never` or `ls_<listingId>_<s|f|r>_<n|c|l>` callback formats**: they are frozen and pinned in `checkCallbackData.ts` (with `skip_reason_*`), and must stay within 64 bytes. Slice 5 adds `draft_edit_title_<userId>`, `draft_edit_price_<userId>`, `draft_edit_location_<userId>`, `draft_meetup_<userId>` and the `faq_1` start payload (the meeting-point button; it must keep opening FAQ node 1), frozen the same way. Slice 4 adds `al_<searchId>_<d|r>`, `lb_<id>_<u|d|m>` (buyer-match labels, next to `lb_<id>_<s|n|k>`) and the `s_<captureId>` start payload, frozen the same way. The `c_<id>` / `l_<id>` start payloads are pinned there too. The same goes for `lc_<r|s|x>_<listingId>` and `sc_go` / `sc_no`.
- **Don't use `var`**; prefer `const`/`let`. Follow the ESLint rules in `eslint.config.mjs`.
- **Don't keep per-user flow state in memory** (a `Map`, a module variable, a temporary listener): it is lost on restart.
- **Don't mutate `config.json` directly at runtime from code** — use `adminService` to handle `/config` updates.

- **An approved bot post ends only by Sold, expiry or take-down.** Never add a seller-facing way to remove one: `lc_x_` is refused on a `bot` listing and is not on its keyboards. Expiry changes the listing only; the post stays `approved`.
- **Nothing goes to a member unless `nudges` is on or the admin confirmed `/stalecheck`.**

### Adding a New Command
1. Add the handler method to an appropriate service (or create a new one in `src/services/`).
2. Register it in `BotController.registerRoutes()` in `src/controllers/botController.ts` with `cmd("name", handler)` (a thin wrapper over `command()` in `src/controllers/commands.ts`). Matching is anchored at the start of the message, case-insensitive, matches the exact command name, and accepts `/name` or `/name@ourbot` only; `/name@otherbot` is ignored. Pass `{ detached: true }` only for long jobs.
3. Add help strings to `src/locales/<lang>/common.json` for all languages and reference them in `showHelp()`.
4. Update the `/help` display in `botController.ts` if the command is user-facing, and add the command to the Commands table here and in `docs/README.md`.
5. Extend `src/tests/checkRoutes.ts` or `checkPlatform.ts` if the routing changes.

### Adding a New Locale
1. Create a new directory `src/locales/<lang>/` (e.g., `src/locales/ru/`).
2. Add a `common.json` file in the new directory, filling in all keys from `LocaleStrings`.
3. Run `pnpm run check-locals` — it will error on any missing keys.
4. Set `"lang": "<lang>"` in `config.json` to activate it as default (users can override with `/lang`).

---

## Key Files Quick Reference

| File | Purpose |
|------|---------|
| `src/bot.ts` | App entry point |
| `src/controllers/botController.ts` | All Telegram event routing |
| `src/controllers/commands.ts` | Anchored, case-insensitive command matcher |
| `src/controllers/middleware.ts` | ensureUser, auth guard, error boundary, expired-button catch-all |
| `src/services/wizardService.ts` | /newPost wizard over persisted drafts |
| `src/services/inputService.ts` | Wizard prompts and price validation |
| `src/services/postService.ts` | Post formatting & Telegram message management |
| `src/services/moderationService.ts` | Approve/reject logic, reject-reason prompt |
| `src/services/myPostsService.ts` | User post management (bump, sold; Sold also ends the listing) |
| `src/services/publishService.ts` | submitPost(): trusted sellers publish at once, others go to moderation |
| `src/services/trustService.ts` | isTrustedSeller(): approved or sold post, no moderator take-down in 90 days |
| `src/services/takeDownService.ts` | Moderator take-down (td_) |
| `src/services/captureNoteService.ts` | Opt-in capture notes and the `mk_` buttons |
| `src/services/groupListingService.ts` | Group listings, the `ls_` buttons, edit sync |
| `src/services/lifecycleService.ts` | Refresh/sold/remove, nudge, expiry, `lc_` buttons |
| `src/services/staleCheckService.ts` | `/stalecheck` and the `sc_` buttons |
| `src/services/ephemeralNotes.ts` | Send/edit/delete a private note (ephemeral Bot API) |
| `src/services/adminService.ts` | Runtime config command |
| `src/services/paymentService.ts` | Handles Telegram Stars donations |
| `src/models/Post.ts` | Post Mongoose schema |
| `src/models/User.ts` | User Mongoose schema |
| `src/models/Draft.ts` | Wizard draft schema (collection `drafts`) |
| `src/repositories/draftRepository.ts` | Draft access and expiry |
| `src/repositories/sessionStore.ts` | Mongo store for v2 sessions (`bot_sessions`) |
| `src/types/index.ts` | All shared TypeScript interfaces |
| `src/locales/` | Directory containing localized UI strings by language |
| `config.json` | Runtime bot configuration |
