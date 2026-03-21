# 🛍️ NodeSaleBot

A Telegram sales bot that lets users create sale listings through a guided conversational flow. Posts go through admin moderation before being published to a public sales group.

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
- **Hebrew Localization** — All UI strings externalized in `locals.json`
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

### Prerequisites

- **Node.js** 18+
- **MongoDB** running locally (or a remote URI)
- A **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)

### 1. Clone & Install

```bash
git clone https://github.com/Mishkile/SMISHKI-SALES-BOT.git
cd SMISHKI-SALES-BOT
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
  "timeOut": 1440,
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
| `timeOut`           | Post expiration timeout in minutes                |
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
| Telegram API | node-telegram-bot-api       |
| Database     | MongoDB + Mongoose          |
| Config       | JSON (config.json)          |
| i18n         | JSON (locals.json)          |

---

## 📜 License

See [LICENSE.txt](../LICENSE.txt) for details.