# Testing

```bash
pnpm run lint            # ESLint
pnpm run build           # tsc type check
pnpm test                # every check below, in parallel (src/tests/runAll.ts)
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
| `check-rich` | Rich-message builders, golden strings (`UPDATE_GOLDEN=1` to update, then review the diff), the `/faq` widget (size limit, open tab, right-to-left marks, phone buttons) | no |
| `check-docs` | This documentation: see below | no |

The Mongo-gated checks print `[SKIP]` and pass when `MONGO_URI` is unset, so a green local run without it is not full coverage. Use a throwaway database, never production:

```bash
docker run -d --rm --name test-mongo -p 127.0.0.1:27028:27017 mongo:8.2
MONGO_URI=mongodb://127.0.0.1:27028/SalesBotTestDB pnpm test
```

## How `pnpm test` runs

`src/tests/runAll.ts` starts the scripts in parallel and prints each one's output as a single block when it finishes, then a summary. It exits non-zero if any script failed, and lists the scripts that printed `[SKIP]`. Run one script alone with `pnpm run check-<name>`.

- **One database per script.** Each script gets `MONGO_URI` with its own database name (`SalesBotTestDB_flows`, ...), so a script that wipes collections only wipes its own. A single script run by hand uses the `MONGO_URI` as given.
- **`check-routes` runs alone, last.** The `/config` command writes `config.json` (the script restores it), and every other script reads that file at import.
- **No fixed sleeps after an update.** The harness (`src/tests/harness.ts`) counts outstanding updates, fake Telegram calls and MongoDB commands, and `idle()` returns once none is left. Use it instead of `sleep(n)` before asserting that something did or did not happen. It does not see timers the code schedules on purpose (the quick-listing album delay): wait for those explicitly, then `idle()`.
- CI sets `TS_NODE_TRANSPILE_ONLY=true` for the test step only; `pnpm run build` already type-checks `src/tests`.

## `check-docs`

Fails if:

- a command registered in `src/controllers/botController.ts` is missing from [Commands](Commands.md), or a row there is no longer registered;
- a key in `src/services/configSchema.ts` or `config.json.example` is missing from [Config](Config.md), or a row there is unknown;
- a link between pages, or a full link to a wiki page, is broken, or a link leaves `docs/` (a wiki can't follow it; use a full URL);
- a page names a `src/` or `scripts/` path that doesn't exist. The changelog is exempt, since it describes history.

## Not in `pnpm test`

- `check-dump`: schema compatibility of a restored production dump. Needs `DUMP_MONGO_URI`, and it mutates that database.
- `src/tests/synthetic*.ts`: manual runs that send real messages on the **test** bot and groups, then clean up.
- `/test` in the bot: in-bot cases from `src/tests/testCases.ts`.

## The wiki

`.github/workflows/wiki.yml` copies `docs/` to the wiki on every push to master that touches it. Links between pages stay relative with `.md`, and the workflow rewrites them. `docs/README.md` becomes the wiki's Home. It is also the repo's front page, so its links are full wiki URLs.
