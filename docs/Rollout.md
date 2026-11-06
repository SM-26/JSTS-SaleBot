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

To measure first: `/label` and `/stats` show the classifier's precision.

## Buyers: `buyerMatches`

| Value | What happens |
| :--- | :--- |
| `off` | Nothing. |
| `shadow` | Logs which listings a "wanted" message would match. |
| `on` | Sends private buyer notes and saved-search alerts. |

Buyer notes need `captureMode` `shadow` or `optin`, because they hang off captured "wanted" messages; saved-search alerts don't.

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
