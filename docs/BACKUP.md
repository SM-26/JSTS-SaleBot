# Backup, restore and census

Runbook for the MongoDB database `SalesBotDB` (collections `posts` and `users`) on the production host. Run commands from `~/JSTS-SaleBot` on the host unless noted. `mongoserver` is the Mongo service in `compose.prod.yaml`; `mongodump`, `mongorestore` and `mongosh` all run inside it.

## 1. Take a dump

Do this, and a census, before any deploy that touches the database layer.

```bash
mkdir -p ~/backups
TS=$(date -u +%Y%m%dT%H%M%SZ)
DC="docker compose -f compose.prod.yaml"

# Dump (gzipped archive streamed out of the container)
$DC exec -T mongoserver mongodump --archive --gzip --db SalesBotDB > ~/backups/salesbot-$TS.archive.gz

# Record the census next to it
$DC exec -T mongoserver mongosh --quiet SalesBotDB --eval "$(cat scripts/census.js)" > ~/backups/census-$TS.json
```

If the host checkout predates `scripts/census.js`, pipe it from the laptop instead:

```bash
ssh <ssh-host> 'cd ~/JSTS-SaleBot && s=$(cat) && docker compose -f compose.prod.yaml exec -T mongoserver mongosh --quiet SalesBotDB --eval "$s"' < scripts/census.js > census-<timestamp>.json
```

`mongorestore --dryRun` only reads the archive header (it reports "0 document(s) restored"), so it does not prove the dump is good. Verify on the laptop instead: copy the dump down (section 2), restore it into a throwaway container, and check that its census matches the one taken on the host.

```bash
docker run -d --rm --name salebot-dumpcheck mongo:8.2
docker exec -i salebot-dumpcheck mongorestore --archive --gzip < salesbot-<timestamp>.archive.gz
docker exec salebot-dumpcheck mongosh --quiet SalesBotDB --eval "$(cat scripts/census.js)" > census-restored.json
diff census-<timestamp>.json census-restored.json   # only generatedAt may differ
docker stop salebot-dumpcheck
```

## 2. Copy a dump to the laptop

Run on the laptop. `<ssh-host>` is your ssh config alias for the deploy host.

```bash
scp '<ssh-host>:backups/salesbot-<timestamp>.archive.gz' '<ssh-host>:backups/census-<timestamp>.json' .
```

The dump contains real user data (names, usernames, Telegram ids). Keep it off shared drives and out of git.

## 3. Restore into a separate database (staging / rehearsal)

Restores into `SalesBotStaging`, leaving `SalesBotDB` alone. Use any Mongo you control, for example the dev stack's `mongoserver` (`docker compose up -d mongoserver`).

```bash
docker compose exec -T mongoserver mongorestore --archive --gzip \
  --nsFrom 'SalesBotDB.*' --nsTo 'SalesBotStaging.*' < salesbot-<timestamp>.archive.gz
```

Point the bot at it with `MONGO_URI=mongodb://mongoserver:27017/SalesBotStaging`.

> **Never run the production bot token against a restored dump.** The data holds real user ids and message ids: the bot would DM real users and edit real messages in the live groups. Use the test bot's token and the test groups in `config.json`.

## 4. Restore over production (disaster recovery only)

Needs the owner's go-ahead. `--drop` replaces the existing collections with the dump's contents.

```bash
DC="docker compose -f compose.prod.yaml"
$DC stop bot                       # no writes while restoring
$DC exec -T mongoserver mongorestore --archive --gzip --drop < ~/backups/salesbot-<timestamp>.archive.gz
$DC up -d bot
$DC logs -f bot
```

Then run the census (section 5) and diff it against the one saved with the dump.

## 5. Census

`scripts/census.js` is read-only: it counts documents, flags posts with missing message ids, orphaned posts and bad media, and histograms document shapes (field names and BSON types, never values). Its output holds no personal data, only Mongo `_id`s, so it is safe to paste into a PR.

```bash
docker compose -f compose.prod.yaml exec -T mongoserver \
  mongosh --quiet SalesBotDB --eval "$(cat scripts/census.js)" > census-after.json

diff census-before.json census-after.json
```

Only `generatedAt` should differ on an idle database. Expect `users.shapes` to drift on its own: users still carrying the legacy `isAdmin` field get `authLevel` instead the next time they talk to the bot. New or changed `shapes` entries mean documents written after the deploy have different fields from old ones; new entries under `collections` are collections created by the new version.

## Alternative: cold volume backup

With the whole stack stopped, tar the Docker volume. It is a byte copy, so restore it into the same Mongo version (`mongo:8.2`).

```bash
docker compose -f compose.prod.yaml down
docker run --rm -v jsts-salebot_mongodb_data:/data:ro -v ~/backups:/backup alpine \
  tar czf /backup/mongodb_data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /data .
docker compose -f compose.prod.yaml up -d
```

To restore, stop the stack, empty the volume, and untar the archive back into it the same way (`tar xzf ... -C /data`, volume mounted read-write).
