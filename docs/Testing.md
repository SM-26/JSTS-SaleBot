# Testing

```bash
pnpm run lint            # ESLint
pnpm run build           # tsc type check
pnpm test                # every check below, in this order
```

The checks need a `config.json` (`cp config.json.example config.json`).

| Script | What it checks | Needs `MONGO_URI` |
| :--- | :--- | :--- |
| `check-locals` | Locale JSON syntax, no empty values, key parity across languages, FAQ structure | no |
| `check-config` | `/config` value parsing per key | no |
| `check-classifier` | Classifier fixtures: tiers, price and title parsing, blocked words | no |
| `check-catchup` | Export scan: windows, tiers, merge, `parseCatchupFile` | no |
| `check-claim` | Atomic approve/reject claim under concurrency | yes |
| `check-polling` | Polling-error classification and de-duplication | no |
| `check-callbacks` | Golden test pinning every `callback_data` format | no |
| `check-cards` | Listing and note card builders, callback and start-payload formats | no |
| `check-platform` | Command matcher and middleware (offline harness) | no |
| `check-store` | `MongoSessionStore`: TTL, expiry on read | yes |
| `check-routes` | Route smoke test through the middleware chain | yes |
| `check-flows` | Wizard and reject-reason flows, including a simulated restart | yes |
| `check-market` | Market collections, indexes, capture windows, sweeper, WTB ranking, shadow pipeline | yes |
| `check-buyer` | Buyer notes, saved searches, alert sweep and send-once claim, `/label` matches | yes |
| `check-tiers` | Tier selection, `/verify` permissions, tier layouts at publish and sold | yes |
| `check-rich` | Rich-message builders, golden strings (`UPDATE_GOLDEN=1` to update, then review the diff) | no |
| `check-docs` | This documentation: see below | no |

The Mongo-gated checks print `[SKIP]` and pass when `MONGO_URI` is unset, so a green local run without it is not full coverage. Use a throwaway database, never production:

```bash
docker run -d --rm --name test-mongo -p 127.0.0.1:27028:27017 mongo:8.2
MONGO_URI=mongodb://127.0.0.1:27028/SalesBotTestDB pnpm test
```

## `check-docs`

Fails if:

- a command registered in `src/controllers/botController.ts` is missing from [Commands](Commands.md), or a row there is no longer registered;
- a key in `src/services/configSchema.ts` or `config.json.example` is missing from [Config](Config.md), or a row there is unknown;
- a link between pages is broken or leaves `docs/` (a wiki can't follow it; use a full URL);
- a page names a `src/` or `scripts/` path that doesn't exist. The changelog is exempt, since it describes history.

## Not in `pnpm test`

- `check-dump`: schema compatibility of a restored production dump. Needs `DUMP_MONGO_URI`, and it mutates that database.
- `src/tests/synthetic*.ts`: manual runs that send real messages on the **test** bot and groups, then clean up.
- `/test` in the bot: in-bot cases from `src/tests/testCases.ts`.

## The wiki

`.github/workflows/wiki.yml` copies `docs/` to the wiki on every push to master that touches it. Links between pages stay relative with `.md`, and the workflow rewrites them. `docs/README.md` becomes the wiki's Home.
