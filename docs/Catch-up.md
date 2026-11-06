# Catch-up

A one-off way to offer members the posts they made before the bot was listening. Each step needs the owner, and the bot sends nothing to any member until step 8.

1. Export the group history from Telegram Desktop as JSON. Keep it out of the repo.
2. Run `pnpm run catchup -- <export.json> [--topic N] [--exclude <botUserId>]` on your machine. The default sale topic is General. It writes `catchup.json` and prints counts only, so check them against what you expect.
3. Review `catchup.json` yourself. Nothing moves on until you are happy with it.
4. Send it to the bot in a private chat as a file with the caption `/catchup import`. The bot replies with counts and deletes your message.
5. Delete `catchup.json` and the export copy. Both hold member text.
6. On the test bot, run `/test` "Catch-up offer to me" and read the note and the DM.
7. Approve the final note text.
8. Run `/catchup send` on the production bot, with `/config captureMode optin` set. These are separate switches: under `shadow`, armed offers wait while their 30-day clock keeps running.

`/catchup` alone shows counts.

Offers expire 30 days after `/catchup send`, and a re-import replaces offers not yet sent. A member is never offered twice, and "Don't ask again" members are skipped.
