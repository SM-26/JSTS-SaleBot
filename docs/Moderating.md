# Moderating

The commands are listed in [Commands](Commands.md).

## New sellers: review before publishing

A new seller's post arrives in the moderation topic with **Approve** and **Reject**. `/pending` lists whatever is waiting.

**Reject** posts a prompt with four preset reasons. Press one, or **reply to that prompt** with your own text. A message that is not a reply to the prompt is ignored, and the bot reminds you to reply, so a reason can't land on the wrong post. `/cancel` in the group forgets your open prompts.

The author is told exactly once, with **Fix and resend** and, if `rulesUrl` is set, the group rules link. Prompts are stored in the database, so a restart doesn't lose them.

## Trusted sellers: review after publishing

A seller with an approved or sold post, and no moderator take-down in the last 90 days, publishes at once. You get a "Published (trusted seller)" card, so check those after the fact.

## Taking a post down

Every published post card has **🚫 Take down** (when its listing exists). It removes the post from the sales group and tells the author. The post can no longer be bumped or marked sold, and the seller loses trusted status for 90 days.

## Group listings

With `captureMode: optin`, a member can add their own group message to the market. A seller's first listing of any kind sends you a take-down card; the bot posts nothing public. The card offers:

- **Take down:** ends the listing. The member's message stays.
- **Take down and delete original post:** asks once more, then deletes the message and all its photos. Telegram lets a bot delete only messages under 48 hours old, and the card says how many were left.

A seller's own Remove never deletes anything.

## Verified and top sellers

`/verify` and `/unverify` set or clear the ✅ mark. Top seller 🏅 is earned: by default 60% of at least 3 ended listings sold. With `tierLayouts: true` these sellers publish in a richer layout.
