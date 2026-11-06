# Running

## Secrets: `.env`

Copy `.env.example`.

| Variable | Description |
| :--- | :--- |
| `BOT_TOKEN` | Token from [@BotFather](https://t.me/BotFather) |
| `MONGO_URI` | MongoDB connection string. Inside compose, use the service name: `mongodb://mongoserver:27017/SalesBotDB` |
| `MONGO_MAX_ATTEMPTS` | Optional. Connection tries before the bot exits (default `5`, 5 s apart). Raise it if Mongo is slow after a host reboot |

Settings are in `config.json`: see [Config](Config.md).

**Never run the bot, or a check, against the production token or database from a dev machine.** Only one process can poll a token at a time.

## Development: `docker-compose.yaml`

Runs the dockerfile's `development` target with ts-node, source bind-mounted, plus MongoDB and mongo-express.

```bash
docker compose up -d          # add --build after changing dependencies or the dockerfile
docker compose logs -f bot
```

The database UI is at `http://localhost:8081` (`admin` / `pass`), and the debugger on `localhost:9221`.

## Without Docker

Needs Node 20.19+ (CI runs 24), pnpm (pinned by `packageManager`, so `corepack enable`) and a MongoDB.

```bash
pnpm install
pnpm run dev                  # ts-node, no build
pnpm run build && pnpm start  # compiled
```

## Production: `compose.prod.yaml`

Pushing a `v*` tag publishes the `production` target to `ghcr.io/sm-26/jsts-salebot`, for amd64 and arm64, tagged with the version and `latest`. The host only pulls. On the host, next to `.env`, `config.json` and `blocklist/`:

```bash
docker compose -f compose.prod.yaml pull
docker compose -f compose.prod.yaml up -d
docker compose -f compose.prod.yaml logs -f bot
```

- **Pin or roll back:** `BOT_TAG=1.1.0 docker compose -f compose.prod.yaml up -d`.
- **`config.json`** is mounted, not baked in, and the container exits without it. It must be writable by UID 1000, because `/config` saves to it: `sudo chown 1000:1000 config.json`.
- **MongoDB** listens on `127.0.0.1:27017` only, because it has no auth.
- **Database UI on demand:** `docker compose -f compose.prod.yaml --profile tools up -d mongo-express`, then `stop mongo-express` when done. It listens on `127.0.0.1:8081`; from a laptop use `ssh -L 8081:localhost:8081 <host>`.
- **First publish only:** GHCR creates the package as private. Set it to Public once, so the host can pull without logging in.

Before a deploy that touches the database, see [Backup](BACKUP.md) and [Rollout](Rollout.md).

### Blocked words

`./blocklist/` on the host is mounted read-only, and the bot reads `blocklist/blockedWords.json`. **Before the first deploy**, create the folder and copy `src/config/blockedWords.json` into it. Edit it with any editor; the bot re-reads it within about 60 s, with no restart.

If it is missing, the bot logs `[ERROR - blockedWords]` and uses the list in the image. A broken edit (invalid JSON, not an array of strings, a blank or `*`-only entry) is logged the same way, and the last good list stays active.

### Moving a host from the dev compose file

The project name is the same, so the `jsts-salebot_mongodb_data` volume is reused:

```bash
docker compose down
docker compose -f compose.prod.yaml up -d
```

## Test stack: `compose.test.yaml`

For showing the bot to admins on the **test bot and test groups**. It builds the production image from your checkout and keeps its own database, and it refuses any token but the test bot's. The `.env` next to it must hold the test token; `TEST_ENV_FILE` points at another file.

```bash
cp config.test.json.example config.test.json   # once; every feature on, in Hebrew
docker compose -f compose.test.yaml up -d --build
```

- **Watch it:** Docker Desktop, Containers, `jsts-salebot-test`.
- **Update:** `git pull`, then the `up -d --build` command again. Data stays.
- **Make someone an admin:** they send `/start` to the test bot. Then in `http://localhost:8082` (`admin` / `pass`), open `SalesBotTestDemo`, `users`, and set `authLevel` to `2` (`1` for a moderator).
- **Start over empty:** `docker compose -f compose.test.yaml down -v`.

Stop this stack before using the test token any other way.
