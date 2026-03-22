# 🛍️ JSTS Sale Bot
[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](LICENSE)  
[![Version](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/SM-26/d0f70dbe1fa864c035f90ddf5fcce2a5/raw/version_JSTS-SaleBot.json)](VERSION.md)  
  
(pronounced as "Just Sale Bot") is a Telegram sales bot that lets users create sale listings through a guided conversational flow. Posts go through admin moderation before being published to a public sales group.

Built with **TypeScript**, **node-telegram-bot-api**, and **MongoDB**.

---

## ✨ Features

- **Guided Post Creation** — Step-by-step flow: title → description → price → location → photos
- **Price Validation** — Optional numeric price validation (configurable)
- **Photo Upload** — Multi-photo support with download & local storage
- **Live Preview** — Users see a formatted preview before submitting
- **Admin Moderation** — Posts sent to a moderation group with approve/reject buttons
- **Rejection Reasons** — Admins can provide an optional reason when rejecting
- **Auto-Publish** — Approved posts are forwarded to a public sales group
- **Forum Topics** — Moderation and approved posts target specific group topics
- **Multi Localization** — All UI strings externalized in `locals.json`
- **User Mentions** — Deep-links (`tg://user`) for users without a username

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
│   ├── moderationService.ts  # Approve/reject logic & rejection reasons
│   └── userService.ts        # User registration
└── types/
    └── index.ts              # TypeScript interfaces (BotConfig, LocaleStrings…)
```

---

## ⚡ Quick Start

### 🐳 Run with Docker (Recommended)
The easiest way to get the bot, database, and database management UI running is via Docker. This ensures all services are networked correctly out of the box.

#### Configure Environment:
Ensure your .env is set up. For Docker, use:
``` env
MONGO_URI=mongodb://mongodb:27017/SalesBotDB
```

#### Launch Services:

```bash
docker compose up -d
```
#### Monitor & Manage:

Bot Logs: `docker compose logs -f bot`

Database UI: Access Mongo Express at `http://localhost:8081` to manage your collections. username is `admin` and password is `pass`

### Prerequisites

- **Node.js** 18+
- **MongoDB** running locally (or a remote URI)
- A **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)

### 1. Clone & Install

```bash
git clone https://https://github.com/SM-26/JSTS-SaleBot.git
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
  "lang": "he",
  "moderationGroupId": -100XXXXXXXXXX,
  "approvedGroupId": -100XXXXXXXXXX,
  "moderationTopicId": 15,
  "approvedTopicId": 73,
  "validatePrice": true,
  "minimumPhotos": 0
}
```

| Field               | Description                                       |
|---------------------|---------------------------------------------------|
| `lang`              | Locale key (matches `locals.json`)                |
| `moderationGroupId` | Telegram group where posts are reviewed           |
| `approvedGroupId`   | Telegram group where approved posts are published |
| `moderationTopicId` | Forum topic ID for moderation messages            |
| `approvedTopicId`   | Forum topic ID for published posts                |
| ~~`timeOut`~~           | ~~Post expiration timeout in minutes~~                |
| `validatePrice`     | Require numeric price input                       |
| `minimumPhotos`     | Minimum photos required per post (0 = optional)   |

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
| Config       | JSON ([config.json](../config.json))          |
| i18n         | JSON ([locals.json](../locals.json))          |

---

## 📜 License

See [LICENSE.txt](../docs/LICENSE.txt) for details.

## Todo list
- [ ] make a logo for this project
- [ ] better readme.md
- [ ] wrap this project in docker
- [ ] double check translations and all of the strings
- [ ] make sure that the /test is working from docker
- [ ] make sure we implement an expiration mechanism somehow
- [ ] setup .github folder with everything like the old project.
- [ ] add an admin only command: /pending that will list to the admin all of the pending post. after /pending the admin should have someway to approve/reject each post.either by inline buttons or by link to the mod group.
- [ ] add an admin only command: /clearpending to mark all of the pending post as expired. they can not be published anymore.
- [ ] maybe set up a logging channel?
- [ ] handle idle state
- [ ] fix `[ERROR - HandleStart]  Post validation failed: price: Cast to Number failed for value "NaN" (type number) at path "price"`

