# Commands

`check-docs` fails if a registered command is missing here, or a row here is no longer registered.

Commands are case-insensitive, and `/name@ourbot` also works. All of them work only in a private chat with the bot, except `/pending` and `/cancel`, which also work in a group.

## Everyone

| Command | What it does |
| :--- | :--- |
| `/start` | Welcome greeting. Also handles deep links, such as `/start sell`. |
| `/newPost` | Start a sale post. With a draft in progress it offers Continue or Start over. |
| `/cancel` | Drop your draft. In the moderation group: forget your pending reject prompts. |
| `/myposts` | Your posts and group listings: bump, change price, sold, refresh, remove, relist. |
| `/alerts` | `/alerts <text>` saves a search (needs `buyerMatches: on`). Alone, it lists, removes and renews them, in every mode. |
| `/lang` | Choose your language. |
| `/faq` | Airsoft FAQ, as a widget with a 📄 Text version button ([Localization](Localization.md#the-faq)). Only when `enableFaq` was on at startup. |
| `/donate` | Donate Telegram Stars. Refused when `donationsEnabled` is off. |
| `/help` | List the commands you can use. |

## Moderators

| Command | What it does |
| :--- | :--- |
| `/pending` | Posts waiting for approval, with Approve and Reject. |
| `/clearpending` | Expire every pending post at once. |
| `/auth` | Show a user's level, by self, id, username or reply. |
| `/verify` | `/verify <user>` sets the ✅ verified mark. |
| `/unverify` | `/unverify <user>` clears it. |
| `/stats` | Classifier numbers: tiers, merges, label precision, and notes sent and added once notes are on. |

## Admins

| Command | What it does |
| :--- | :--- |
| `/config` | View or change settings, such as `/config dailyBumpLimit 5`. See [Config](Config.md). |
| `/promote` | Raise a user's level: user to moderator to admin. |
| `/demote` | Lower a user's level. |
| `/activeUsers` | Users with a draft in progress. |
| `/broadcast` | Post to the sales group as the bot, by replying to a message or typing one. |
| `/broadcastUsers` | DM every active user and every author of a pending or approved post. Text only; reports failures. |
| `/label` | Label a random would-list row as sale or not sale, to measure the classifier. 🔗 Dead link marks a row whose group post was deleted: it is not offered again and counts for neither precision nor the gate. |
| `/stalecheck` | Dry run, then **Send**, asking legacy sellers if a listing is still for sale. `/stalecheck <userId ...>` limits it to those sellers. |
| `/catchup` | Catch-up offers. See [Catch-up](Catch-up.md). |
| `/test` | In-bot test cases. Seller-post cases refuse to run outside the test bot. |
