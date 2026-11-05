# 🛍️ JSTS Sale Bot
[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](LICENSE)  
[![Version](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/SM-26/d0f70dbe1fa864c035f90ddf5fcce2a5/raw/version_JSTS-SaleBot.json)](VERSION.md)  
  
(pronounced as "Just Sale Bot") is a Telegram sales bot that lets users create sale listings through a guided conversational flow. Posts go through admin moderation before being published to a public sales group.

This is Built with **TypeScript**, **node-telegram-bot-api**, and **MongoDB** and is a JS version of [GoSaleBot](https://github.com/SM-26/GoSaleBot/)

---

## ✨ Features

- **Guided Post Creation** — Step-by-step flow: title → description → price → location → photos (with a step indicator)
- **Price Validation** — Optional numeric price validation, accepting thousands separators (`2,000`)
- **Media Upload** — Multi-photo and video support
- **Rich Messages** — Posts, `/help`, and reports render as Telegram **Rich Messages** (Bot API 10.2): headings, block quotes, lists, dividers and media galleries — with inline buttons attached to the same message
  - ⚠️ **Not supported in Telegram X.** It shows Rich Messages as "Unsupported message", so posts can't be read there. Use an official Telegram app.
- **Description Formatting** — Bold, italic, underline, strikethrough, spoiler, code and text links typed in the description step are kept and rendered in the post
- **Configurable Media Layout** — Multiple photos render as a swipeable **slideshow** or a **collage** grid (`mediaLayout`)
- **Persistent Flows** — A post in progress, a donation amount prompt and a pending reject reason are stored in MongoDB, so a bot restart or deploy loses nothing. Abandoned drafts expire after `timeOut` minutes (`0` = never)
- **Continue or Start Over** — `/newPost` with a draft in progress asks whether to continue or start over; `/cancel` drops it
- **Live Preview** — Users see a formatted preview, with Confirm/Cancel on the same message
- **Admin Moderation** — Posts sent to a moderation group with approve/reject buttons
- **Pending Management** — Admins can list (`/pending`) and bulk-expire (`/clearpending`) posts
- **Rejection Reasons** — Moderators pick one of four preset reasons (buttons), reply to the bot's prompt with their own. The author is told exactly once, and the message carries **Fix and resend** and, when `rulesUrl` is set, a **Group rules** button
- **Trusted-Seller Publishing** — A seller with an approved or sold post and no moderator take-down in the last 90 days publishes at once. The moderation group gets a "Published (trusted seller)" card to review after the fact
- **Take Down** — Moderators can take down any published post from its card. The group message is removed, the author is told, the post can no longer be bumped or marked sold, and the seller loses trusted status for 90 days
- **Blocked-Word Check** — A blocked word in the title, description, price or location is caught at the preview (for everyone, trusted sellers too): the bot names the word and asks for that field again
- **Post Bumping** — Users can bump their approved posts to the top (subject to daily limits)
- **Donations** — Users can support the bot via Telegram Stars (`/donate`)
- **Auto-Publish** — Approved posts (and trusted sellers' posts) are forwarded to a public sales group
- **Broadcasts** — Announce to the channel (`/broadcast`) or DM active/pending/approved users directly (`/broadcastUsers`)
- **Forum Topics** — Moderation and approved posts target specific group topics
- **Multi Localization** — User-specific language preferences with automatic detection from Telegram language settings. Supports multiple languages in structured `src/locales/<lang>/common.json` files.
- **Shadow Classifier (market groundwork)** — With `captureMode: "shadow"` the bot records messages in the sale topic into per-sender posting windows (90 s, closed after 30 s of quiet), classifies each (`strict`, `ask`, `wtb`, `none`) and logs what automatic capture *would* have done (`shadow_log`, 120 days). It **sends nothing** to the group or to members. Captured text lives 7 days. `buyerMatches: "shadow"` also logs which live listings a "wanted" message would match
- **Opt-in Capture Notes** — With `captureMode: "optin"`, a member who posts a sale message in the sale topic gets a **private note** (an ephemeral message only they see, nothing public) asking whether to add it to the market: **Add**, **Not now** or **Don't ask again**. Add makes a *group listing* that points at their own message; the member can mark it **Sold**, **Refresh** or **Remove** from the note, from `/myposts` or from a bot card, and editing the message keeps the listing in step. Reposting the same text refreshes the listing. The bot never touches the member's message and a seller can never remove an approved bot post. At most 3 notes per seller per 24 h; a text a note was already sent for is not asked again for 30 days. A seller's first captured listing gets a **Take down** card in the moderation topic (group listings are post-moderated)
- **Deep Links** — `t.me/<bot>?start=c_<captureId>` opens a draft prefilled from a captured message (to complete a missing title or price, refused while another draft is open); `?start=l_<listingId>` opens the management card of a group listing
- **`/label` and `/stats`** — Admins hand-label would-list rows as sale / not sale (`/label`); moderators see tier counts, merge counts and label precision against the go/no-go gate (`/stats`)
- **User Mentions** — Deep-links (`tg://user`) for users without a username
- **Role-Based Access Control (RBAC)** — Granular authorization with User, Moderator, and Admin roles, replacing simple `isAdmin` flags.

### 🌐 How Multi Localization Works

1. Locale definition
   - Each language has its own `src/locales/{lang}/common.json` file (currently `en`, `he`, `ru`).
   - Translation keys are shared across locales (same keys, different values).

2. Locale resolution
   - When a user interacts with the bot, `UserService.ensureUser()` writes or updates the user profile.
   - `localeService.resolveUserLocale(user)` prefers:
     - `user.preferredLocale` (from `/lang` selection)
     - `user.languageCode` (Telegram user language hint)
     - bot config default (`config.lang`)

3. Message rendering
   - `localeService.t(locale, key)` loads `common.json` for `locale`, caches it, and returns translation.
   - Missing keys are fallback to the key string with a warning log.

4. `/lang` command
   - Sends an inline keyboard with available locales from `localeService.availableLocales`.
   - Updates `user.preferredLocale` with `userRepository.updateUser(...)`.
   - Future replies use chosen locale.

5. Configuration tests
   - `src/tests/checkLocals.ts` validates matching keys across `src/locales/*/common.json` and reports missing entries.

---

## 🤖 Commands

### 👤 User Commands
| Command | Description |
| :--- | :--- |
| `/start` | Show a welcome greeting. |
| `/newPost` | Start the flow to create a new sale post (Title → Desc → Price → Location → Media). With a draft in progress it offers Continue or Start over. |
| `/cancel` | Cancel your post in progress. |
| `/myposts` | View your active posts, bump them to the top, or mark them as sold. Also lists your group listings (Sold / Refresh / Remove) and the capture-note setting (stop or resume asking). |
| `/lang` | Set your preferred language for bot interactions. |
| `/faq` | View airsoft frequently asked questions and information. |
| `/donate` | Support the bot by donating Telegram Stars. |
| `/help` | Show the list of available commands. |

### 🛡️ Moderator Commands
| Command | Description |
| :--- | :--- |
| `/pending` | View a list of posts waiting for approval with inline Approve/Reject buttons. |
| `/clearpending` | Bulk expire (reject) all currently pending posts. |
| `/auth` | View a user's authorization level and role (supports self, ID, username, or reply). |
| `/cancel` | In the moderation group: forget your pending reject-reason prompts. |
| `/stats` | Shadow classifier numbers: rows per tier, would-list and merge counts, label precision, and (once notes are sent) the opt-in line: notes, added, rate. |

### 📝 For moderators

When you press **Reject**, the bot posts a prompt in the group with four preset reasons. Press one, or **reply to that prompt message** with your own text. A message that is not a reply to the prompt is ignored (the bot reminds you to reply), so the reason can't be attached to the wrong post. The author is notified exactly once, with a **Fix and resend** button and the group rules link (if `rulesUrl` is set). The prompt is stored in the database, so it survives a bot restart.

Every published post card carries **🚫 Take down** (when its listing exists). Trusted sellers' posts appear in the group at once with a "Published (trusted seller)" card, so check those after the fact. Taking a post down removes it from the sales group, tells the author, and ends their trusted status for 90 days.

### ⚙️ Admin Commands
| Command | Description |
| :--- | :--- |
| `/promote` | Increase a user's authorization level (e.g., User to Moderator, Moderator to Admin). |
| `/demote` | Decrease a user's authorization level (e.g., Admin to Moderator, Moderator to User). |
| `/activeUsers` | List users with a post in progress (a live draft). |
| `/config` | View or update bot configuration at runtime (e.g., `/config dailyBumpLimit 5`). |
| `/label` | Label a random unlabeled would-list row as sale / not sale (or skip) to measure the shadow classifier. |
| `/test` | Run built-in test scenarios to verify bot functionality. |
| `/broadcast` | Send a message to the approved channel, either by replying to an existing message or by typing a new message. |
| `/broadcastUsers` | Send a direct message (PM) to every active user and every author of a pending or approved post (de-duplicated, excluding you). Text only; reports per-recipient delivery failures. |


---

## ❓ FAQ System

The bot supports a **localized, hierarchical FAQ system** that allows users to view Frequently Asked Questions in their preferred language. This was implemented to provide searchable, structured information without hardcoding text into services.

### Overview

- **Location**: `src/locales/<lang>/faq.json` (e.g., `en/faq.json`, `he/faq.json`)
- **Access**: Users run `/faq` to view all available questions and answers
- **Localization**: Each language has its own FAQ file with identical structure but translated content
- **Hierarchy**: Questions and answers are organized using dot notation (e.g., `1`, `1.1`, `2`, `2.1.1`) to create nested topics
- **Design Reference**: See [Issue #20](https://github.com/SM-26/JSTS-SaleBot/issues/20) for architectural decisions on this feature

### FAQ File Structure

Each FAQ file follows this JSON schema:

```json
{
    "meta": {
        "locale": "en"
    },
    "nodes": {
        "1": "Main Question Title",
        "1.1": "Answer or sub-question content",
        "1.2": "Another sub-topic at same level",
        "2": "Second Main Question",
        "2.1": "Answer to second question",
        "2.1.1": "Nested deeper level answer"
    }
}
```

**Key structure elements:**
- **`meta.locale`**: Language code (must match the directory name, e.g., `en`, `he`, `de`)
- **`nodes`**: Object containing all FAQ entries as key-value pairs
  - **Keys**: Hierarchical identifiers using dot notation
    - `1`, `2`, `3` = Main topics (top level)
    - `1.1`, `1.2`, `2.1` = Sub-topics (one level deep)
    - `1.1.1`, `2.1.2` = Deeper nesting (unlimited levels)
  - **Values**: Plain text strings (no Markdown; HTML tags like `<b>`, `<i>` are supported if you manually format in code)

### Adding or Editing FAQ Content

#### 1. **Edit an existing locale's FAQ**

Open `/src/locales/<lang>/faq.json` and modify the `nodes` object:

```json
{
    "meta": { "locale": "en" },
    "nodes": {
        "1": "What is Airsoft?",
        "1.1": "Airsoft is a recreational sport...",
        "2": "What equipment do I need?",
        "2.1": "Basic equipment includes a weapon, protective gear..."
    }
}
```

#### 2. **Create a new language's FAQ**

1. Create a new directory: `src/locales/<lang>/` (e.g., `src/locales/fr/`)
2. Copy the structure from an existing FAQ file and translate all values:

```bash
mkdir -p src/locales/fr
cp src/locales/en/faq.json src/locales/fr/faq.json
# Then edit src/locales/fr/faq.json with French translations
```

3. Update the `meta.locale` field to match the language code:

```json
{
    "meta": { "locale": "fr" },
    "nodes": { ... }
}
```

4. Run the locale validation test to ensure the file is syntactically correct:

```bash
pnpm run test
```

### Best Practices

✅ **Do:**
- Keep FAQ entries concise and user-friendly
- Use consistent numbering (avoid gaps: use `1`, `1.1`, `1.2`, `2`; not `1`, `1.5`, `3`)
- Test the FAQ file with: `pnpm run test` (validates JSON syntax and node structure)
- Use the `/faq` command in the bot to preview your FAQ before committing
- Update **all** language files when modifying structure (to keep them in sync)

❌ **Don't:**
- Leave the `meta.locale` field empty or mismatched with the directory name
- Use special characters or newlines in FAQ text—keep values as single-line strings
- Skip validation after editing—`pnpm run test` ensures file integrity
- Create duplicate or out-of-order node keys (structure is for logical presentation, not sorting)

### Technical Implementation

- **Loading**: `localeService.getFaqs(locale)` reads `faq.json` and returns the `nodes` object
- **Error Handling**: If a FAQ file is missing or invalid, users see: *"FAQ information not available for your language."*
- **Caching**: FAQ files are loaded on-demand; no in-memory cache (lightweight approach)
- **Locale Resolution**: FAQ respects user-specific locale preference (see [Multi Localization](#-how-multi-localization-works) section)

---

## 📁 Project Structure

```
src/
├── bot.ts                    # Entry point — connects DB, starts polling
├── config/
│   ├── blockedWords.json     # Built-in blocked-word list (editable on the host, see Deploying below)
│   ├── db.ts                 # MongoDB connection
│   └── pollingErrors.ts      # Classifies and de-duplicates polling errors for the log
├── controllers/
│   ├── botController.ts      # Route registration (middleware chain) & flow orchestration
│   ├── commands.ts           # Anchored, case-insensitive command matcher (`@ourbot` only)
│   ├── middleware.ts         # ensureUser, session key, auth guard, error boundary, expired-button catch-all
│   └── callbackRoutes.ts     # callback_data → action routing
├── models/
│   ├── Post.ts               # Post schema (title, price, photos, status…)
│   ├── User.ts               # User schema (userId, name, authLevel, preferredLocale…)
│   ├── Draft.ts              # /newPost wizard draft (collection `drafts`, one per user)
│   ├── Listing.ts            # Market listing, from a bot post or a group message (collection `listings`)
│   ├── Capture.ts            # Posting window of a sale-topic sender (collection `captures`, 7-day TTL)
│   ├── ShadowLog.ts          # What automatic capture would have done (collection `shadow_log`, 120-day TTL)
│   └── Member.ts             # Group member last seen (collection `members`)
├── repositories/
│   ├── postRepository.ts     # Post CRUD
│   ├── userRepository.ts     # User CRUD (upsert)
│   ├── draftRepository.ts    # Draft CRUD, atomic media push/claim, expiry against timeOut
│   ├── sessionStore.ts       # Mongo store for v2 sessions (collection `bot_sessions`)
│   ├── listingRepository.ts  # Listings: per-post upsert, seller lookups, matching candidates
│   ├── captureRepository.ts  # Capture windows: atomic append, close, classify claims
│   ├── shadowLogRepository.ts # Shadow log rows, labels and stats
│   └── memberRepository.ts   # Member last-seen touches
├── services/
│   ├── wizardService.ts      # /newPost wizard as a step machine over drafts; /cancel
│   ├── inputService.ts       # Wizard prompts (step indicator) and price validation
│   ├── postService.ts        # Post Rich Message formatting, publish to groups, bump/sold edits
│   ├── myPostsService.ts     # User post management (list, bump, mark sold)
│   ├── moderationService.ts  # Approve/reject logic; reject-reason prompt (presets or reply)
│   ├── pendingService.ts     # /pending listing & /clearpending bulk expire
│   ├── adminService.ts       # /config, /broadcast, promote/demote/auth
│   ├── configSchema.ts       # Per-key type rules validating /config values
│   ├── broadcastUsersService.ts # /broadcastUsers audience resolution & throttled DM fan-out
│   ├── paymentService.ts     # Donation invoice creation & payment event handling
│   ├── userService.ts        # User registration
│   ├── classifier.ts         # Pure message classifier: tier, rules, parsed title/price, text hash, token overlap
│   ├── classifierData.json   # Classifier word lists and aliases (data only)
│   ├── blockedWords.ts       # Hot-reloaded blocked-word matcher (`src/config/blockedWords.json`)
│   ├── captureService.ts     # Records sale-topic messages into windows (silent)
│   ├── shadowService.ts      # Closes windows, classifies, writes `shadow_log` rows
│   ├── matchService.ts       # Ranks live listings for a "wanted" message
│   ├── marketService.ts      # Reconciles bot posts into listings
│   ├── sweeper.ts            # Overlap-free interval jobs (10 s capture tick, hourly reconcile)
│   ├── shadowAdminService.ts # /label and /stats
│   ├── captureNoteService.ts # Private opt-in capture notes: ask, refresh, Add / Not now / Don't ask again (mk_)
│   ├── groupListingService.ts # Group listings: Add, Sold / Refresh / Remove (ls_), edit sync, /myposts section
│   ├── listingCards.ts       # Pure card builders (ask note, management card) and callback_data helpers
│   ├── ephemeralNotes.ts     # The only caller of the ephemeral Bot API methods (send, edit, delete a note)
│   ├── deepLinks.ts          # `start=c_` / `start=l_` payloads and group message links
│   ├── localeService.ts      # User-specific localization & FAQ loading
│   └── faqService.ts         # FAQ command handler with locale-specific content
├── locales/
│   ├── en/                   # English: common.json (UI strings) + faq.json
│   ├── he/                   # Hebrew
│   └── ru/                   # Russian
├── tests/
│   ├── checkLocals.ts        # Localization integrity script (run by `pnpm test`)
│   ├── checkClassifier.ts    # Classifier fixtures
│   ├── checkMarket.ts        # Market collections, capture windows, sweeper, shadow pipeline (needs MONGO_URI)
│   ├── syntheticCapture.ts   # Manual: 20 messages through the controller on the TEST bot/group; sends nothing
│   ├── syntheticOptin.ts     # Manual: one real private note + one moderation card on the TEST bot/groups, cleaned up after
│   ├── checkListingCards.ts  # Card builders, callback_data and start payload formats (`pnpm run check-cards`)
│   ├── fixtures.ts           # `seedCapture`: a classified capture straight through the model
│   ├── checkCallbackData.ts  # Golden test pinning callback_data formats
│   ├── checkPlatform.ts      # Offline checks: command matcher, middleware
│   ├── checkSessionStore.ts  # Session store (needs MONGO_URI)
│   ├── checkRoutes.ts        # Route smoke test (needs MONGO_URI)
│   ├── checkFlows.ts         # Wizard + reject-reason flows, incl. simulated restart (needs MONGO_URI)
│   ├── checkModerationClaim.ts # Atomic approve/reject claim (needs MONGO_URI)
│   ├── checkPollingErrors.ts # Polling error classification
│   ├── harness.ts            # Offline bot harness (fake fetch) shared by the checks
│   ├── configSchema.check.ts # Asserts for /config value parsing
│   ├── broadcastUsers.check.ts # Asserts for send-error mapping & failure truncation
│   └── testCases.ts          # Manual test scenarios (in-bot /test)
└── types/
    └── index.ts              # TypeScript interfaces (BotConfig, LocaleStrings…)
scripts/
└── census.js                 # Read-only database census (see docs/BACKUP.md)
```

---

## ⚡ Quick Start

### 🐳 Run with Docker (Recommended)

The `dockerfile` is a multi-stage build with **two deployment targets**:

| Target | Use case | How it runs | Image contents |
| :--- | :--- | :--- | :--- |
| **`development`** | Local development & testing | `ts-node` directly — no build step. Source is bind-mounted, so edits apply live. Node debugger on `9221`. | Includes devDependencies (ts-node, eslint…) |
| **`production`** | Real deployment | Pre-compiled `node dist/bot.js`, as the non-root `node` user | Production dependencies only — slim |

Both stages install the exact pnpm version pinned by the `packageManager` field in `package.json`, so Docker, CI and local never drift.

#### 1. Development — `docker compose`

`docker-compose.yaml` targets the **development** stage and brings up the bot, MongoDB and mongo-express together, networked out of the box.

In `.env`, point at the Mongo **service name** (not `localhost` — inside the container that would mean the bot itself):

``` env
MONGO_URI=mongodb://mongoserver:27017/SalesBotDB
```

Launch:

```bash
docker compose up -d          # add --build after changing dependencies or the dockerfile
```

Monitor & manage:
- Bot logs: `docker compose logs -f bot`
- Database UI: Mongo Express at `http://localhost:8081` — username `admin`, password `pass`
- Debugger: attach to `localhost:9221`

#### 2. Production — `compose.prod.yaml`

Pushing a `v*` tag runs `.github/workflows/publish-image.yml`, which builds the **production** stage for `linux/amd64` and `linux/arm64` and publishes it to `ghcr.io/sm-26/jsts-salebot`, tagged with the version (`1.2.0`, `1.2`) and `latest`. The deploy host only pulls; it never runs `pnpm install` or `tsc`.

On the host, next to `compose.prod.yaml`, `.env` and `config.json`:

```bash
docker compose -f compose.prod.yaml pull
docker compose -f compose.prod.yaml up -d
docker compose -f compose.prod.yaml logs -f bot
```

- **Pin a version:** `BOT_TAG=1.1.0 docker compose -f compose.prod.yaml up -d`. Rolling back is the same command with the previous tag.
- **Database UI on demand:** `docker compose -f compose.prod.yaml --profile tools up -d mongo-express`, then `docker compose -f compose.prod.yaml stop mongo-express` when done. It listens on `127.0.0.1:8081` only; from a laptop use an SSH tunnel: `ssh -L 8081:localhost:8081 <host>`.
- **MongoDB** listens on `127.0.0.1:27017` only, because it has no auth. In `.env`, use the service name: `MONGO_URI=mongodb://mongoserver:27017/SalesBotDB`.

> **`config.json` is not baked into the image.** It is environment-specific (and gitignored), so it is mounted at `/app/config.json` — the container exits on startup without it. It must be **writable by UID 1000** (the image's `node` user): `/config` changes are persisted back to this file. On the host: `sudo chown 1000:1000 config.json`.

> **The blocked-word list is editable on the host.** `compose.prod.yaml` bind-mounts the host folder `./blocklist` at `/app/blocklist` (read-only) and sets `BLOCKED_WORDS_PATH=/app/blocklist/blockedWords.json`. **Before the first deploy**, create `./blocklist/` next to `config.json` and copy `src/config/blockedWords.json` from the repo into it. Edit it with any editor; the bot re-reads it within about 60 s, no restart. (It is a folder and not a single file on purpose: editors that save by rename give a file a new identity, and a single-file mount would keep showing the old one.) If the folder or file is missing, the bot logs `[ERROR - blockedWords]` and uses the list built into the image. A broken edit (invalid JSON, not an array of strings, or an entry that is blank or only `*`) is logged the same way and the last good list stays active.

> **Deploying slice 0 (market core + shadow classifier).** The new collections are additive; the 2.0.1 image still runs against the same database. (1) Create `./blocklist/` and copy `src/config/blockedWords.json` into it (see above). (2) The production `config.json` predates the `captureMode` and `buyerMatches` keys, so capture starts **off**. Turn it on as an admin with `/config captureMode shadow` and `/config buyerMatches shadow`; both only record, nothing is sent to the group. (3) Confirm `LEGACY_CUTOFF` (`2026-11-04`, in `src/services/marketService.ts`): posts created before it become held legacy listings, posts after it become normal ones.

> **Deploying 3.1.0 (opt-in capture notes).** Take the `mongodump` from `docs/BACKUP.md` first and deploy only on the owner's go-ahead. Deploy with `captureMode: shadow` (no behaviour change); set `/config captureMode optin` only after a second account (not the poster, not an admin) has confirmed in the test group that other members do not see the note. `/config captureMode shadow` stops the notes at once.

> **First publish only:** GHCR creates the package as private. Set its visibility to **Public** once in the package settings, so the host can pull without logging in.

**Switching an existing host from the dev compose file.** The project name is the same, so the `jsts-salebot_mongodb_data` volume with all posts and users is reused:

```bash
docker compose down                                # dev file; volumes are kept
docker compose -f compose.prod.yaml up -d
docker compose -f compose.prod.yaml logs -f bot
```

Backups, restores and the read-only database census are in [BACKUP.md](BACKUP.md).

## Dev build  
### Prerequisites

- **Node.js** 20.19+ (required by `mongoose`; CI runs Node 24, the Docker images use Node 26)
- **pnpm** (the repo pins it via `packageManager` — `corepack enable` or install it globally)
- **MongoDB** running locally (or a remote URI)
- A **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)

### 1. Clone & Install

```bash
git clone https://github.com/SM-26/JSTS-SaleBot.git
cd JSTS-SaleBot
pnpm install
```

### 2. Configure Environment

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

```env
BOT_TOKEN=your_telegram_bot_token
MONGO_URI=mongodb://localhost:27017/SalesBotDB
```

`MONGO_MAX_ATTEMPTS` is optional (default `5`, 5 seconds apart). The bot exits
if MongoDB is still unreachable after that many tries, rather than starting
without a database; the container's restart policy then retries until Mongo is
up. Raise it if your MongoDB is slow to become ready after a host reboot.

### 3. Configure Bot Settings

Edit `config.json`:

```json
{
  "lang": "en",
  "moderationGroupId": -100XXXXXXXXXX,
  "approvedGroupId": -100XXXXXXXXXX,
  "moderationTopicId": 11,
  "approvedTopicId": 22,
  "validatePrice": true,
  "minimumPhotos": 1,
  "dailyBumpLimit": 2,
  "donationsEnabled": true,
  "enableFaq": true,
  "timeOut": 1440,
  "mediaLayout": "slideshow",
  "broadcastTopicId": null
}
```

Values set via `/config` are validated per key (see `src/services/configSchema.ts`) — enums only accept their allowed values, numbers must be numeric, and nullable fields accept `null`.

| Field                | Type | Description                                       |
|----------------------|------|---------------------------------------------------|
| `lang`               | enum | Default locale key — must be a folder in `src/locales/` (`en`, `he`, `ru`) |
| `moderationGroupId`  | number | Telegram group where posts are reviewed           |
| `approvedGroupId`    | number | Telegram group where approved posts are published |
| `moderationTopicId`  | number \| null | Forum topic ID for moderation messages (set to `null` if not using topics) |
| `approvedTopicId`    | number \| null | Forum topic ID for published posts (set to `null` if not using topics) |
| `broadcastTopicId`   | number \| null | Forum topic for `/broadcast` (`null` = the General topic) |
| `validatePrice`      | boolean | Require numeric price input (accepts `2,000`)   |
| `minimumPhotos`      | number | Minimum photos/videos required per post (0 = optional) |
| `dailyBumpLimit`     | number | Maximum times a user can bump a post per day      |
| `donationsEnabled`   | boolean | Enable/Disable the /donate command                |
| `enableFaq`          | boolean | Enable/Disable the /faq command                   |
| `mediaLayout`        | enum | How multiple photos render: `"slideshow"` (swipeable) or `"collage"` (grid) |
| `captureMode`        | enum | `"off"`, `"shadow"` or `"optin"`: `shadow` records and classifies sale-topic messages without sending anything; `optin` also sends the private capture notes. `shadow` is the kill switch (notes stop at once, existing listings stay manageable). Code default `off`; `config.json.example` ships `shadow` |
| `buyerMatches`       | enum | `"off"` or `"shadow"`: log the listings a "wanted" message would match. Code default `off`; `config.json.example` ships `shadow` |
| `nudges`             | boolean | Reserved for a later slice; nothing reads it yet |
| `rulesUrl`           | string | `https://t.me/` link to the group rules (empty = none); adds a "Group rules" button to reject messages |
| `timeOut`            | number | Minutes of inactivity before a `/newPost` draft expires (`0` = never). Checked on every touch against the live value, so `/config timeOut` applies immediately |

### 4. Run

```bash
# Development (with ts-node)
pnpm run dev

# Production
pnpm run build
pnpm start
```

---

## 🔄 How It Works

```
User sends /newPost
    ↓
Bot collects: title → description → price → location → photos
(each answer is saved in the drafts collection, so a restart loses nothing)
    ↓
Preview shown to user → Confirm / Cancel
    ↓
Post saved to MongoDB (status: pending)
    ↓
Sent to moderation group with ✅ Approve / ❌ Reject buttons
    ↓
┌─ Approved → Published to sales group + user notified
└─ Rejected → Moderator picks a preset or replies → user notified once
(Trusted sellers skip the wait: published at once, reviewed afterwards; a moderator can Take down)
```

---

## 🛠️ Tech Stack

| Layer        | Technology                  |
|--------------|-----------------------------|
| Runtime      | Node.js + TypeScript        |
| Package manager | pnpm (pinned via `packageManager`) |
| Telegram API | [node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api) **v2.3.0** (Bot API 10.2, Rich Messages) |
| Database     | MongoDB + Mongoose (collections `posts`, `users`, plus `drafts` and `bot_sessions` for persistent flows) |
| Config       | JSON (`config.json`), validated by `src/services/configSchema.ts` |
| i18n         | Structured JSON (`src/locales/<lang>/common.json` + `src/locales/<lang>/faq.json`)  |
| Validation   | `pnpm run test` — locale syntax/keys/FAQ structure, callback_data formats, command matcher, and the wizard/moderation flows (the Mongo-backed checks need `MONGO_URI`) |

---

## 📜 License

See [LICENSE.txt](../docs/LICENSE.txt) for details.

## Todo list
- [ ] make a logo for this project
- [ ] rework the faq with rich message
