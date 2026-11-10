# 🛍️ JSTS Sale Bot
[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://github.com/SM-26/JSTS-SaleBot/blob/master/docs/LICENSE.txt)
[![Version](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/SM-26/d0f70dbe1fa864c035f90ddf5fcce2a5/raw/version_JSTS-SaleBot.json)](https://github.com/SM-26/JSTS-SaleBot/wiki/VERSION)

JSTS Sale Bot (say "Just Sale Bot") is a Telegram marketplace bot. Members create sale posts in a private chat with the bot. New sellers' posts go through a moderation group first; trusted sellers publish at once and are reviewed afterwards.

It is built with TypeScript, [node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api) 2.4.0 (Bot API 10.4) and MongoDB, and is a JS version of [GoSaleBot](https://github.com/SM-26/GoSaleBot/).

> ⚠️ Posts are Telegram Rich Messages, which Telegram X shows as "Unsupported message". Use an official Telegram app.

## What it does

- A guided post wizard with preview, blocked-word check and photo or video upload. A draft survives a bot restart.
- Moderation with preset reject reasons, post-publish take-down and trusted sellers.
- `/myposts` to bump, change the price or mark a post as sold.
- Saved searches and private notes that match buyers with listings.
- Listings made from members' own group messages, with their consent.
- English, Hebrew and Russian, chosen per user.

Newer features are off until an admin turns them on. See [Rollout](https://github.com/SM-26/JSTS-SaleBot/wiki/Rollout).

## Quick start

```bash
cp .env.example .env                  # set BOT_TOKEN and MONGO_URI
cp config.json.example config.json    # set the group ids
docker compose up -d
```

Without Docker, the production stack and the test stack are in [Running](https://github.com/SM-26/JSTS-SaleBot/wiki/Running).

## Documentation

| For | Pages |
| :--- | :--- |
| Sellers and buyers (Hebrew) | [Selling](https://github.com/SM-26/JSTS-SaleBot/wiki/Selling), [Buying](https://github.com/SM-26/JSTS-SaleBot/wiki/Buying) |
| Moderators and admins | [Moderating](https://github.com/SM-26/JSTS-SaleBot/wiki/Moderating), [Commands](https://github.com/SM-26/JSTS-SaleBot/wiki/Commands), [Config](https://github.com/SM-26/JSTS-SaleBot/wiki/Config), [Rollout](https://github.com/SM-26/JSTS-SaleBot/wiki/Rollout), [Catch-up](https://github.com/SM-26/JSTS-SaleBot/wiki/Catch-up) |
| Whoever runs the bot | [Running](https://github.com/SM-26/JSTS-SaleBot/wiki/Running), [Backup](https://github.com/SM-26/JSTS-SaleBot/wiki/BACKUP) |
| Developers | [Architecture](https://github.com/SM-26/JSTS-SaleBot/wiki/Architecture), [Testing](https://github.com/SM-26/JSTS-SaleBot/wiki/Testing), [Localization](https://github.com/SM-26/JSTS-SaleBot/wiki/Localization), [Version](https://github.com/SM-26/JSTS-SaleBot/wiki/VERSION), [Changelog](https://github.com/SM-26/JSTS-SaleBot/wiki/CHANGELOG) |

These pages live in `docs/` in the repo and are copied to the wiki on every merge to master. Change them through a PR; edits made on the wiki are overwritten.
