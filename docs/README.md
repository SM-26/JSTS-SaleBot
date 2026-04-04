# 🛍️ JSTS Sale Bot
[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](LICENSE)  
[![Version](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/SM-26/d0f70dbe1fa864c035f90ddf5fcce2a5/raw/version_JSTS-SaleBot.json)](VERSION.md)  
  
(pronounced as "Just Sale Bot") is a Telegram sales bot that lets users create sale listings through a guided conversational flow. Posts go through admin moderation before being published to a public sales group.

This is Built with **TypeScript**, **node-telegram-bot-api**, and **MongoDB** and is a JS version of [GoSaleBot](https://github.com/SM-26/GoSaleBot/)

---

## ✨ Features

- **Guided Post Creation** — Step-by-step flow: title → description → price → location → photos
- **Price Validation** — Optional numeric price validation (configurable)
- **Media Upload** — Multi-photo and video support
- **Live Preview** — Users see a formatted preview before submitting
- **Admin Moderation** — Posts sent to a moderation group with approve/reject buttons
- **Pending Management** — Admins can list (`/pending`) and bulk-expire (`/clearpending`) posts
- **Rejection Reasons** — Admins can provide an optional reason when rejecting
- **Post Bumping** — Users can bump their approved posts to the top (subject to daily limits)
- **Donations** — Users can support the bot via Telegram Stars (`/donate`)
- **Auto-Publish** — Approved posts are forwarded to a public sales group
- **Forum Topics** — Moderation and approved posts target specific group topics
- **Multi Localization** — User-specific language preferences with automatic detection from Telegram language settings. Supports multiple languages in structured `src/locales/<lang>/common.json` files.
- **User Mentions** — Deep-links (`tg://user`) for users without a username

### 🌐 How Multi Localization Works

1. Locale definition
   - Each language has its own `src/locales/{lang}/common.json` file (e.g., `en/common.json`, `he/common.json`).
   - Translation keys are shared across locales (same keys, different values).

2. Locale resolution
   - When a user interacts with the bot, `UserService.ensureUser()` writes or updates the user profile.
   - `localeService.resolveUserLocale(user)` prefers:
     - `user.preferredLocale` (from `/lang` selection)
     - `user.languageCode` (Telegram user language hint)
     - bot config default (`config.lang`, currently `en`)

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
| `/start` | Start the flow to create a new sale post (Title → Desc → Price → Location → Media). |
| `/myposts` | View your active posts, bump them to the top, or mark them as sold. |
| `/lang` | Set your preferred language for bot interactions. |
| `/faq` | View airsoft frequently asked questions and information. |
| `/donate` | Support the bot by donating Telegram Stars. |
| `/help` | Show the list of available commands. |


### 🛡️ Admin Commands
| Command | Description |
| :--- | :--- |
| `/pending` | View a list of posts waiting for approval with inline Approve/Reject buttons. |
| `/clearpending` | Bulk expire (reject) all currently pending posts. |
| `/config` | View or update bot configuration at runtime (e.g., `/config dailyBumpLimit 5`). |
| `/test` | Run built-in test scenarios to verify bot functionality. |


---

## � FAQ System

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
npm run test
```

### Best Practices

✅ **Do:**
- Keep FAQ entries concise and user-friendly
- Use consistent numbering (avoid gaps: use `1`, `1.1`, `1.2`, `2`; not `1`, `1.5`, `3`)
- Test the FAQ file with: `npm run test` (validates JSON syntax and node structure)
- Use the `/faq` command in the bot to preview your FAQ before committing
- Update **all** language files when modifying structure (to keep them in sync)

❌ **Don't:**
- Leave the `meta.locale` field empty or mismatched with the directory name
- Use special characters or newlines in FAQ text—keep values as single-line strings
- Skip validation after editing—`npm run test` ensures file integrity
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
│   └── db.ts                 # MongoDB connection
├── controllers/
│   └── botController.ts      # Route registration & flow orchestration
├── models/
│   ├── Post.ts               # Post schema (title, price, photos, status…)
│   └── User.ts               # User schema (userId, name, isAdmin…)
├── repositories/
│   ├── postRepository.ts     # Post CRUD
│   └── userRepository.ts     # User CRUD (upsert)
├── services/
│   ├── inputService.ts       # Reusable input collection (text, price, photos, confirm)
│   ├── photoService.ts       # Photo download & media group builder
│   ├── postService.ts        # Post formatting, preview, publish to groups
│   ├── myPostsService.ts     # User post management (list, bump, mark sold)
│   ├── moderationService.ts  # Approve/reject logic & rejection reasons
│   ├── adminService.ts       # Admin configuration commands
│   ├── paymentService.ts     # Donation invoice creation & payment event handling
│   ├── userService.ts        # User registration
│   ├── localeService.ts      # User-specific localization & FAQ loading
│   └── faqService.ts         # FAQ command handler with locale-specific content
├── locales/
│   ├── en/
│   │   ├── common.json       # English UI strings (commands, messages, help text)
│   │   └── faq.json          # English FAQ with hierarchical structure
│   └── he/
│       ├── common.json       # Hebrew UI strings
│       └── faq.json          # Hebrew FAQ with hierarchical structure
├── tests/
│   ├── checkLocals.ts        # Localization integrity script
│   └── testCases.ts          # Manual test scenarios
└── types/
    └── index.ts              # TypeScript interfaces (BotConfig, LocaleStrings…)
```

---

## ⚡ Quick Start

### 🐳 Run with Docker (Recommended)
The easiest way to get the bot, database, and database management UI running is via Docker. This ensures all services are networked correctly out of the box.

#### Configure Environment:
Ensure your .env and config.json files are set up. For Docker, use:
``` env
MONGO_URI=mongodb://mongoserver:27017/SalesBotDB
```

#### Launch Services:

```bash
docker compose up -d
```
#### Monitor & Manage:

Bot Logs: `docker compose logs -f bot`

Database UI: Access Mongo Express at `http://localhost:8081` to manage your collections. username is `admin` and password is `pass`

## Dev build  
### Prerequisites

- **Node.js** 18+
- **MongoDB** running locally (or a remote URI)
- A **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)

### 1. Clone & Install

```bash
git clone https://github.com/SM-26/JSTS-SaleBot.git
cd JSTS-SaleBot
npm install
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
  "donationsEnabled": true
}
```

| Field                | Description                                       |
|----------------------|---------------------------------------------------|
| `lang`               | Locale key (matches `src/locales/<lang>/common.json`)                |
| `moderationGroupId`  | Telegram group where posts are reviewed           |
| `approvedGroupId`    | Telegram group where approved posts are published |
| `moderationTopicId`  | Forum topic ID for moderation messages (Optional: set to null if not using topics) |
| `approvedTopicId`    | Forum topic ID for published posts (Optional: set to null if not using topics) |
| `validatePrice`      | Require numeric price input                       |
| `minimumPhotos`      | Minimum photos required per post (0 = optional)   |
| `dailyBumpLimit`     | Maximum times a user can bump a post per day      |
| `donationsEnabled`   | Enable/Disable the /donate command                |
| `enableFaq`          | Enable/Disable the /faq command                   |
| ~~`timeOut`~~        | ~~Post expiration timeout in minutes~~            |

### 4. Run

```bash
# Development (with ts-node)
npm run dev

# Production
npm run build
npm start
```

---

## 🔄 How It Works

```
User sends /start
    ↓
Bot collects: title → description → price → location → photos
    ↓
Preview shown to user → Confirm / Cancel
    ↓
Post saved to MongoDB (status: pending)
    ↓
Sent to moderation group with ✅ Approve / ❌ Reject buttons
    ↓
┌─ Approved → Published to sales group + user notified
└─ Rejected → Optional reason prompt → user notified
```

---

## 🛠️ Tech Stack

| Layer        | Technology                  |
|--------------|-----------------------------|
| Runtime      | Node.js + TypeScript        |
| Telegram API | [node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api)       |
| Database     | MongoDB + Mongoose          |
| Config       | JSON (`config.json`)         |
| i18n         | Structured JSON (`src/locales/<lang>/common.json` + `src/locales/<lang>/faq.json`)  |
| Validation   | `npm run test` — Validates locale file syntax, key consistency, and FAQ structure |

---

## 📜 License

See [LICENSE.txt](../docs/LICENSE.txt) for details.

## Todo list
- [x] wrap this project in docker
- [x] make sure that the /test is working from docker
- [x] setup .github folder with everything like the old project.
- [x] double check translations and all of the strings
- [ ] make a logo for this project
- [ ] better readme.md
- [ ] make sure we implement an expiration mechanism somehow
- [ ] maybe set up a logging channel?
- [ ] handle idle state
