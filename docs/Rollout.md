# Rollout

Newer features ship off, or in a mode that sends nothing, and an admin turns them on with `/config`. The keys are in [Config](Config.md).

Before a deploy that touches the database, take a dump ([Backup](BACKUP.md)) and get the owner's go-ahead. New collections and fields are additive, so rolling back to an older image against the same database still works.

## Capture: `captureMode`

| Value | What happens |
| :--- | :--- |
| `off` | Nothing is recorded. |
| `shadow` | Sale-topic messages are recorded into posting windows (90 s, closed after 30 s of quiet), classified, and logged as what capture would have done. **Nothing is sent.** Captured text is kept 7 days, the log 120 days. |
| `optin` | Also sends a private note asking the poster to add the message to the market: at most 3 per seller per 24 h, and a text is not asked about again for 30 days. |

Before `optin`, have a second account (not the poster, not an admin) confirm in the test group that other members don't see the note. Notes reach only apps online when they are sent.

Kill switch: `/config captureMode shadow`. Notes stop at once and existing listings stay manageable.

To measure first: `/label` and `/stats` show the classifier's precision. A sale post is `strict` (automatic capture would list it) or `ask` (the note asks the seller). A post with two or more different prices is `ask`, unless one stated total covers everything (`הכל ב-1500`, `סה״כ 1,100₪`, no smaller than any item price); a struck-through or old price (`במקום`, `היה`, `קניתי`) does not count. The hybrid gate on `/stats` needs at least 100 labeled rows at 97% precision or better; dead-link rows count for neither.

## Buyers: `buyerMatches`

| Value | What happens |
| :--- | :--- |
| `off` | Nothing. |
| `shadow` | Logs which listings a "wanted" message would match. |
| `on` | Sends private buyer notes and saved-search alerts. |

Buyer notes need `captureMode` `shadow` or `optin`, because they hang off captured "wanted" messages; saved-search alerts don't.

What matches a "wanted" message (`src/services/matchService.ts`), the same for notes, alerts and the one-message draft:

- A listing must have every model name in the message (`glock`, `m4`, `ak`, or a code like `ssp18`) and one of its model numbers (`17 או 19`). They must be on one line, within the listing's first five lines, and that line must not start with a part. `gbb`, `aeg` and `hpa` decide only when nothing else does.
- A part request, one that names the part before any model (`מחסנית`, `קפיץ`, `נרתיק`, `כוונת`, `קת`, `בלון`, …), needs a listing line that sells that part. Any other request skips listings that start with a part. A part word after the model (`גלוק 19 על גז`) is only a detail.
- These are not search words: a price the buyer names (`400₪`, `מחיר 300`), a round number (`1400`), a quantity (`14 מ״מ`, `1.3j`), a phone number, and anything after a trade-in cue (`מציע`, `להחלפה`, `תמורת`, `יש לי`, …). In a listing, whatever follows `החלפה על` or `מחפש` is what the seller wants, so it doesn't match either.
- `עד 800`, `תקציב 800` and a range (`1300-1400`, `בין 2000 ל 2800`, whose top counts) set a ceiling; `2300+` does not.
- These get no note: a swap request (`מחפש החלפה על…`), a sale posted as wanted (`למכירה` before any model), and a bare two-digit number (`מחפש 45`). A Latin word right before the number makes it a model (`cz 75`), and that word must match too.
- A trade-only listing never matches: `רק להחלפה`, or a swap word with no price.

Before `on`: the matcher was benchmarked offline on a 30-day replay of the group, with 80 wanted posts blind-labelled. The target is 80% of noted buyers getting at least one right item. It now scores 22 of 23 on the dev set and 21 of 27 on the held-out set (78%). Turning it on is the owner's call.

Kill switch: `/config buyerMatches shadow`. Notes and alerts stop at once. Saved searches stay and resume, except that a 403 (the buyer blocked the bot) deletes that buyer's searches, and the 60-day TTL still applies.

## One-message listing: `quickListing`

Off, the wizard behaves as before. Blocked words and moderation apply the same either way.

## Lifecycle: `nudges` and `/stalecheck`

- A listing **expires after 30 days whatever the setting**. An approved bot post stays `approved` and its group message is untouched; `/myposts` offers Relist.
- `nudges: true` also sends a DM at 7 days without a refresh. If the DM can't be delivered, the nudge waits for the seller's next sale-topic message, which needs capture on.
- `/stalecheck` asks sellers of legacy (held) listings whether each is still for sale. Nothing goes out before **Send**, and unanswered listings expire 7 days later. **Bump** lifts a hold.

Nothing goes to a member unless `nudges` is on or an admin confirmed `/stalecheck`.

## Seller tiers: `tierLayouts`

Off, every post uses the regular layout. `/test` samples still show the others.

## Catch-up

A one-off, with its own steps: [Catch-up](Catch-up.md).

## First deploy with market collections

Create `./blocklist/` on the host ([Running](Running.md)). A production `config.json` from before these keys has capture off, so turn it on with `/config captureMode shadow` and `/config buyerMatches shadow`. Posts created before `LEGACY_CUTOFF` in `src/services/marketService.ts` become held legacy listings, later ones normal listings.
