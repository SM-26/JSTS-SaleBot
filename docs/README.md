# GoSaleBot

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](LICENSE)
[![Version](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/SM-26/8c14f658878fc5f1ecf8eee4d07f3cb4/raw/version_GoSalesBot.json)](VERSION.md)


---
<p align="center">
  <img src="./docs/GoSaleBot_Banner.png" alt="GoSaleBot Banner">
</p>
A modular, production-ready Telegram bot for handling sale posts with moderation, photo support, i18n, admin commands, and full Docker deployment.

---

## Features

- Guided sale post creation (title, description, price, location, photos)
- Moderation workflow (approve via ✅, reject via reply)
- Multi-language support (English, Czech, Hebrew)
- Admin commands for runtime config and pending review
- SQLite persistent storage
- Easy deployment with Docker & Docker Compose
- Inline keyboard for photo stage
- Configurable via environment and runtime admin commands
- Handles users without a username by using their first and last name.

## Quick Start

```sh
# Clone the repository
git clone https://github.com/<your-username>/GoSaleBot.git
cd GoSaleBot

# Add your Telegram token and group IDs to the .env file
cp .env.example .env
# Edit .env with your values

# Build and run the bot
docker compose up --build
```

## Commands

### User Commands

| Command | Description |
| --- | --- |
| `/start` | Begin creating a sale post |
| `/help` | Shows the help message with all the available commands. |
| `/myposts` | List your posts and allow deleting or marking as sold |

For a full list of commands, including admin commands, see the [detailed documentation](docs/README.md).

## Documentation

- For full technical details, see [docs/README.md](docs/README.md)
- For design and architecture, see [docs/DesignStructure.adoc](docs/DesignStructure.adoc)


## Credits

This project uses the excellent [go-telegram/bot](https://github.com/go-telegram/bot) library for Telegram Bot API integration.

## License

This project is licensed under the Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0) License. See the [LICENSE](LICENSE) file for details.

---

## Environment Variables

The following environment variables are required or supported. These can be set in your `.env` file or managed at runtime with the `/config` admin command:

| Variable | Description | Required |
| --- | --- | --- |
| `TELEGRAM_TOKEN` | Your Telegram bot token | **Yes** |
| `MODERATION_GROUP_ID` | Chat ID for the moderation group | **Yes** |
| `APPROVED_GROUP_ID` | Chat ID for the approved posts group | **Yes** |
| `ADMINS` | Comma-separated list of Telegram user IDs with admin rights | **Yes** |
| `MODERATION_TOPIC_ID` | (optional) Topic/thread ID for moderation group | No |
| `APPROVED_TOPIC_ID` | (optional) Topic/thread ID for approved group | No |
| `LANG` | Bot language (`en`, `cz`, `he`) | No |
| `TIMEOUT_MINUTES` | Timeout in minutes before the bot expires pending posts (default: 1440) | No |
| `VALIDATE_PRICE` | Enable/disable server-side price validation (true/false). Default: true | No |
| `MIN_PHOTOS` | Minimum number of photos required to submit a post. Default: 1 | No |

## Next suggested tasks

- Add `/myposts` pagination or inline-button UI for better UX (currently supports text commands only).
- Implement a way to mark approved-group posts as "sold" (update or delete the message in the approved group).
- Add admin `/broadcast` command (consider rate-limiting / job queue for many users).
- Run `golangci-lint` and address any issues found.
