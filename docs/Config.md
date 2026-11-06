# Config

Settings live in `config.json` (copy `config.json.example`, gitignored, mounted into the container). Admins change them with `/config <key> <value>`. Each value is validated per key by `src/services/configSchema.ts` and written back to the file.

`check-docs` fails if a key in the schema or the example file is missing here.

The two secrets, `BOT_TOKEN` and `MONGO_URI`, are in `.env`, not here. See [Running](Running.md).

## Groups

| Key | Type | Description |
| :--- | :--- | :--- |
| `moderationGroupId` | number | Group where posts are reviewed |
| `approvedGroupId` | number | Group where posts are published |
| `moderationTopicId` | number or null | Forum topic for moderation messages |
| `approvedTopicId` | number or null | Forum topic for published posts |
| `broadcastTopicId` | number or null | Forum topic for `/broadcast` (`null` = General) |
| `rulesUrl` | string | `https://t.me/` link to the group rules (empty = none). Adds a rules button to reject messages |

## Posts

| Key | Type | Description |
| :--- | :--- | :--- |
| `lang` | enum | Default language, a folder in `src/locales/` |
| `timeOut` | number | Minutes of inactivity before a draft expires (`0` = never). Read live |
| `validatePrice` | boolean | Require a numeric price (accepts `2,000`) |
| `minimumPhotos` | number | Minimum photos or videos per post (`0` = optional) |
| `mediaLayout` | enum | `slideshow` or `collage` |
| `dailyBumpLimit` | number | Bumps per post per day |

## Feature switches

What each switch sends, and in which order to turn them on, is in [Rollout](Rollout.md).

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `captureMode` | enum | `off` | `off`, `shadow` (record and classify, send nothing) or `optin` (also send private capture notes). `config.json.example` ships `shadow` |
| `buyerMatches` | enum | `off` | `off`, `shadow` (log what a "wanted" message would match) or `on` (also send buyer notes and alerts). `config.json.example` ships `shadow` |
| `quickListing` | boolean | `false` | A captioned photo, video or album in DM starts a draft. Adds field-edit buttons and the Beit Dagan toggle to previews, and handles `/start sell` |
| `nudges` | boolean | `false` | Send the 7-day refresh nudge. Expiry at 30 days runs regardless |
| `tierLayouts` | boolean | `false` | Post layouts by seller tier. Off, every post uses the regular layout |
| `topSellerPercent` | number | `60` | Top seller: minimum percent of ended listings sold |
| `topSellerMinEnded` | number | `3` | Top seller: minimum ended listings |
| `donationsEnabled` | boolean | on | `/donate`. Read live |
| `enableFaq` | boolean | on | `/faq`. Read at startup, so a change needs a restart |

## Not used yet

Accepted by `/config`, but nothing reads them.

| Key | Type |
| :--- | :--- |
| `faqAllowInGroups` | boolean |
| `faqMaxButtonsPerRow` | number |
| `faqMaxDepth` | number or null |
