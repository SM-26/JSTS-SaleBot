# JSTS-SaleBot 3.0 "the market": design

Status: draft for owner approval (2026-11-04). Source of every number: issue #104, log comments of 2026-11-03.
Next step after approval: `superpowers:writing-plans`, one plan per slice.

## 1. Intent

The sales group ("יד 2 / מכירות / חיפוש", sale topic = thread 1) is a healthy market that the bot is not part of:
about 250 member sale posts a month from 342 sellers, against 1–6 bot posts a month (bot share about 1–3%).
Members sell in seconds by posting a photo and a caption. The bot asks five questions, makes new sellers wait,
and has rejected every first-time seller since August, three of four without a reason. Its listings never end
(28 "approved" posts are 55–214 days old). Buyers get nothing: about 60–200 wanted-to-buy posts a month go unanswered.

3.0 stops asking members to come to the bot. The bot joins the group's own flow:

- it notices a sale post and privately offers to add it to the market;
- it answers a wanted-to-buy post privately with matching items;
- it makes posting through the bot one message;
- it trusts known sellers;
- it closes listings so "for sale" means something.

The group stays the shop window. The bot is the market's memory: what is for sale, what sold, who sells reliably.

## 2. Goals, non-goals, anti-goals

**Goals**

1. Opt-in capture of sale posts in the sale topic (private note "Add to the market?").
2. Shadow classifier beside it, logging what automatic capture would do, with a measured gate for hybrid.
3. Buyer matches: a private note to each wanted-to-buy poster with matching live items, plus a saved-search alert.
4. One-message listing in DM (album + caption → draft → Publish), the wizard as fallback, `t.me/<bot>?start=sell`.
5. Trust-based moderation with a mandatory reject reason (preset buttons).
6. Listings that end: nudge at 7 days, expiry at 30 unless refreshed, Sold/Bump, completed-sales count, member-since.
7. One "still for sale?" message to the 14 sellers of the 28 stale posts (owner approves the exact text).
8. One-time catch-up offer to the sellers of the last 30 days (owner gives the go-ahead).
9. A `/stats` view that tracks the metrics in section 12 from day one.

**Non-goals (3.0)**

- Automatic (hybrid) capture. It is designed here, but only built after the gate in 6.4 passes (slice G, after 3.0).
- Inline search, Mini App catalogue, Contact-seller deep links on group posts, multi-community (`/setup`, welcome
  notes, member tags, guest mode). Directions B-later and C of the pitch.
- AI extraction. The design runs on rules alone; section 10 marks where the AI plugs in later.
- Ratings, verified badges, auto-translate, weekly digests, price-drop alerts (all dropped in #104).
- Moving listings to a separate topic. Listings stay in the sale topic.
- Seller-deleted approved posts (never: Sold is the way out). Editing an approved post's price, text or media is a
  possible later feature, not 3.0 (owner).

**Anti-goals: 3.0 has failed, even if it works, if**

- the bot posts anything publicly in the group that a member did not ask for;
- a wanted-to-buy post is ever listed as a sale;
- a member is nagged: more than one unanswered note per post, or any note after "Don't ask again";
- existing `posts`/`users` data is reshaped, or rollback to the 2.0.1 image is lost, without the owner agreeing to
  that specific case first (see Constraints);
- any Hebrew bot text, or anything the bot publishes, contains a blocked word (5.5);
- the private note is the only place a seller can act from (notes may vanish or never arrive);
- a test touches the production token or database.

## 3. Constraints

- TypeScript, `node-telegram-bot-api` 2.3.0 (upgraded on its own PR before slice 0; has the Bot API 10.3 types:
  `ephemeral_message_parameters`, `editEphemeralMessage*`, `deleteEphemeralMessage`, `Message.ephemeral_message_id`), MongoDB via mongoose.
  No new dependencies.
- Additive data by default: new collections and new optional fields, so the 2.0.1 image can still run against a 3.0
  database. Not absolute (owner): an edge case that is better served by reshaping existing data is brought to the
  owner as its own question, with the reason, a restore-verified dump and a rollback path. This design needs none.
- Private notes (ephemeral messages): an admin bot may send one to any non-bot member at any time
  (`ephemeral_message_parameters.receiver_user_id`). Delivery is not guaranteed, especially to offline users, and
  notes "may disappear after some time or on app restart". So every action in a note also exists in the DM and
  `/myposts`, and every note carries a "Manage in bot" deep link.
- Bots can't DM a user who never started the bot. Durable contact with a group-only member starts when they tap a
  deep link.
- Bots can't read chat history. The catch-up scan uses the owner's Telegram Desktop export, offline.
- Blocked words (5.5): a plain Hebrew substring blacklist, starting with `נשק`. No Hebrew bot text and nothing the
  bot publishes may contain one. Enforced by `check-locals` and at publish time.
- Prod token and prod DB are never used in tests: test bot `@JSTS_testing_bot`, user-facing test group
  `-1002445943058` topic 73 plays the sale topic, moderation test group `-1002474192098` topic 15.
- Prod deploys, and the bot's first unprompted message to real users, each need the owner's go-ahead.
- Every slice follows AGENTS.md: service/repository layering, no `any`, all strings in every locale, `[ERROR - ctx]`
  logging, README features and CHANGELOG updated, callback formats pinned in `check-callbacks`.

Prod facts the builder relies on (2026-11-03): the prod bot is an admin of the sales group with every right except
`can_send_welcome_messages` (not needed). `approvedGroupId` is the sales group, `approvedTopicId` is 1 (the sale
topic; General is 48138, broadcast 54833), `moderationTopicId` 145, `lang` he.

## 4. Decided by the owner (as decided)

| # | Decision |
|---|----------|
| D1 | Capture is opt-in. The note asks "Add to the market?". Nothing is listed until the seller taps. |
| D2 | An automatic classifier runs in shadow mode beside opt-in, logs what it would list, and shows nothing to anyone. |
| D3 | Hybrid (automatic when clear, ask when unclear) only after a live hand-labeled sample shows at least 97% precision. |
| D4 | Moderation is trust-based: new sellers wait for a moderator, sellers with an approved post publish instantly, moderators can take any listing down, a reject always needs a reason. |
| D5 | The 14 sellers of the 28 stale "approved" posts get one "still for sale?" message; the owner approves the exact text. |
| D6 | A one-time catch-up scan of the last 30 days offers sellers a converted listing, sent only after the owner's go-ahead. |
| D7 | The welcome-message right is not needed. |
| D8 | Stay on TypeScript, the current library and MongoDB. |
| D9 | Must work on rules alone; the owner's local AI is an optional later improvement. |
| D10 | Nothing is ever posted publicly by capture. Wanted-to-buy posts are never listed as sales. |

Measured facts these rest on: the strict rule (photo + explicit price + sale words + no wanted-to-buy opener) scored
100/100 on hand labels and covers 2,087 of 2,464 sale-like posts in the export; 39% of sale posts repeat the same
text within 30 days; posts group by "same sender, within 90 s"; about 1 in 6 posts is unclear; about 5% of strict
hits are bundles and 4% are a bare price with the item only in the photo. Private notes were proven live on the test
bot, also in a group where the bot lacks the welcome right, rendering as "Only visible to you" with buttons inside
the card; the `start` deep link opened the bot.

## 5. The model

### 5.1 One market, two sources

A **listing** is one item for sale in the market. It has one of two sources:

- `bot`: a post made through the bot (DM). Content and moderation stay in `posts` exactly as today; the listing
  points at it (`postId`) and carries the market lifecycle.
- `group`: a member's own post in the sale topic that they opted in. The listing points at their message(s); the
  bot never reposts it.

Everything market-wide (buyer matches, nudges, expiry, completed-sales count, `/stats`) reads and writes listings
only. Moderation keeps working on `posts`.

Why a new collection instead of new statuses on `posts`: 2.0.1 reads `posts` everywhere (`/myposts`, Bump re-posts
publicly, the startup `syncSoldPosts` edits group messages). A captured listing inside `posts` would let a rolled-back
image re-post a member's item as a bot post, or try to edit a member's message. A separate `listings` collection is
invisible to 2.0.1.

### 5.2 Listing states

```
             ┌─────── refresh (Bump, "still for sale", repost) ──────┐
             ▼                                                        │
 (created) live ──7 days since refreshedAt──► nudged (still live) ────┘
             │                                     │
             │                        30 days since refreshedAt
             │                                     ▼
             ├── seller: Sold ─────────────► sold
             ├── seller: Remove (group only) ► removed
             ├── moderator: Take down ─────► taken_down
             └── 30 days, no refresh ──────► expired ──seller: Relist──► live
```

`sold`, `removed`, `taken_down` are final. `expired` can be relisted from `/myposts` (or by reposting the same text,
see 6.3). `nudged` is not a status: it's `nudgedAt` set on a live listing.

For a `bot` listing the post moves too, using operations 2.0.1 already does: Sold sets `post.status = "sold"` and
edits the group message (existing `markSoldInGroup`). Expired, removed and taken-down change only the listing; the
post stays `approved` (2.0.1 then shows it as approved, which is the safe direction). Taken-down also deletes the
bot's own group message (the bot has the delete right).

**Sellers can't remove an approved bot post (owner).** It ends only by Sold, expiry or a moderator's take-down, so a
`bot` listing never offers Remove. Remove exists only for `group` listings, where it takes the item out of the
market and never touches the member's own group message.

### 5.3 New collections (all additive)

Field lists are the minimum the behaviour needs; the builder may add fields, never remove or rename once shipped.

**`listings`**

| field | notes |
|---|---|
| `source` | `"bot"` \| `"group"` |
| `origin` | `"dm"` \| `"capture"` \| `"catchup"` \| `"legacy"` (the posts that existed before 3.0) |
| `postId` | for `bot` |
| `chatId`, `messageIds[]` | for `group`: the grouped messages; the first is the link target, updated to the newest repost |
| `sellerId` | Telegram user id as string (same convention as `posts.userId`) |
| `sellerName` | display name at capture time (members who never started the bot have no `users` doc) |
| `title`, `price` (as written), `priceValue` (number, optional), `location`, `text` | parsed; `text` is the normalized caption used for matching and repost detection |
| `textHash` | hash of the normalized text, for repost merging |
| `media[]` | `IMediaItem` file ids seen in the live update (none for catch-up listings) |
| `status` | `live` \| `sold` \| `expired` \| `removed` \| `taken_down` |
| `createdAt`, `refreshedAt`, `nudgedAt?`, `endedAt?`, `endedBy?` | lifecycle clock |
| `note?` | `{ ephemeralMessageId, sentAt }` of the seller's current private note, for edits |
| `isBundle` | true when the text carries two or more prices (6.3) |

Indexes: `{status, refreshedAt}`, `{sellerId, status}`, `{source, postId}` unique-sparse, `{chatId, messageIds}`.
When a listing ends as `removed` or `taken_down`, `text`, `media` and `title` are unset (privacy; the row stays for
metrics).

**`captures`**: one open posting window per sender in the sale topic, before any opt-in.

`{ chatId, senderId, senderName, messageIds[], text, entities, media[], firstAt, lastAt, state, tier, parsed,
note?, listingId? }` with `state` `open → classified → asked → added | declined | ignored`.
TTL index: 7 days after `lastAt`. This is the only place a non-opted-in member's text is kept, and only for a week.

**`shadow_log`**: what automatic capture would have done. No member text.

`{ chatId, messageIds[], senderId, at, tier: "strict" | "ask" | "wtb" | "none", rules: string[], wouldList: bool,
mergeWith?: listingId, label?: "sale" | "not_sale", labeledBy?, labeledAt? }`. TTL 120 days.

**`members`**: group members the bot has seen, whether or not they started the bot.

`{ userId, firstSeenAt, askMode: "ask" | "never", lastNoteAt?, pendingCatchup?: [...] }`. `users` stays the
bot-users collection; `members` never feeds `/broadcastUsers` (it would DM people who can't be DMed).

**`saved_searches`**: `{ userId, query, terms[], maxPrice?, createdAt, expiresAt, lastAlertAt? }`.

**`alert_log`**: `{ searchId, listingId, sentAt, ok }`, unique on `{searchId, listingId}`. Both the dedupe and the
delivery log.

Bot-source listings for existing posts: an idempotent startup **reconcile** creates a `legacy` listing for every
`approved` or `sold` post that has none, and moves a listing to `sold` when its post is `sold`. This is also the
rollback story: posts made or sold under a rolled-back 2.0.1 are picked up on the next 3.x start.

`legacy` listings created from `approved` posts start **on hold** (`hold: true`): no automatic nudge or expiry, and
left out of buyer matches and alerts. `/stalecheck` (11.4) lifts the hold when it sends, with
`refreshedAt` = send time, so the one-time message is the only one those sellers get and its 7-day answer window is
the expiry clock. Posts that become `approved` after 3.0 get normal (non-hold) `bot` listings.

### 5.4 New config keys

All four go into `BotConfig`, `CONFIG_SCHEMA` and `/config` (AGENTS.md rule), and into `config.json.example`,
like `validatePrice`.

| key | values | default in example | meaning |
|---|---|---|---|
| `captureMode` | `off` \| `shadow` \| `optin` | `shadow` | `shadow` logs only; `optin` also sends notes. `hybrid` is added only in slice G. |
| `buyerMatches` | `off` \| `shadow` \| `on` | `shadow` | `shadow` logs matches, `on` sends buyer notes. |
| `nudges` | boolean | `false` | Day-7 "still for sale?" messages. Off until the owner's go-ahead, because they are unprompted messages to real users. Expiry runs regardless (it sends nothing). |
| `rulesUrl` | string | `""` | Link to the group rules, shown as a button on reject notices (9.3). Prod: `https://t.me/airsoft_yad2/54833/115880`. Config, not code, because it is community-specific like the group ids. |

`CONFIG_SCHEMA` has no string kind yet (only boolean, number, enum), so `rulesUrl` adds a `string` kind that
accepts an `https://t.me/` link or empty.

The three switches are live kill switches for the rollout, and each one that sends to real users is flipped only on the owner's
go-ahead. The day counts (7, 30), the window (90 s) and the limits in this
document are constants in code, not config (nobody has asked to tune them).

Capture listens in `approvedGroupId`, sale topic `approvedTopicId`. When `approvedTopicId` is 1 (prod), sale-topic
messages arrive without `message_thread_id` (or with 1); the existing `Number(topicId) !== 1` convention in
`postService` already encodes this. Messages in other topics are ignored.

### 5.5 Blocked words (owner)

A plain substring blacklist on Hebrew text, the same kind the group's Rose bot enforces. It matches the letters, not
the meaning: `נשק` blocks anything that contains it, so it catches "לנשק" as "for a gun" and also blocks "לנשק" as
"to kiss". That false positive is accepted on purpose, for simplicity. Other languages are not checked.

- **The list:** one repo file, `src/config/blockedWords.json`, starting as `["נשק"]`. The owner will add Rose's list
  later. Matching is `text.includes(word)` on the text as written. (My call: a file rather than a config key,
  because it changes rarely and `/config` has no list type.)
- **Bot text:** `check-locals` fails if any `he` string contains a blocked word.
- **What the bot publishes for a user** (wizard and one-message DM listing, 8.1): a title, description, price or
  location containing a blocked word stops at the preview. The bot names the word and asks for that field again
  (the existing field-edit step). This applies to trusted sellers too, because nobody reviews their post first.
- **Capture:** a group post containing a blocked word is tier `none`: no capture, no note, no listing (Rose deletes it
  anyway). An edit that adds one drops the open capture, or ends a live listing as `removed` by the system (never
  `taken_down`, so trust is untouched).
- Buyer notes and alerts show only listing text that already passed one of these checks.

## 6. Capture in the group

### 6.1 What is read

Every message in the sale topic reaches the bot (it is an admin). The capture middleware sits in the global message
handler after the reply-to-bot-post branch, and costs one upsert per message. Ignored: bots (including our own
posts), `sender_chat` senders (anonymous admins, channels; they can't receive a note), service messages, forwards,
replies (conversation, not posts), commands. `edited_message` updates re-parse an open capture or a live listing
that points at that message (a price edit updates the listing).

### 6.2 Grouping

A message joins the sender's open capture if it arrives within 90 s of that capture's `firstAt`; albums
(`media_group_id`) always join. A window **closes** 30 s after its last message, or 90 s after its first. Closing is
done by a sweeper (6.7), not an in-memory timer, so a restart loses nothing. The note therefore arrives 30–90 s after
the post, while the seller is still around. (90 s is the measured grouping; the 30 s quiet period is the builder's
call to make the note arrive sooner.)

### 6.3 Classifier (rules)

`classify(text, hasMedia) → { tier, rules[], parsed }` is a pure function in a new service, shared by capture, DM
listing and the catch-up script. Word lists and city names live in a JSON data file next to it so the owner can read
and extend them.

Tiers, first match wins:

1. `wtb`: a wanted-to-buy opener in the first line (`מחפש`, `מחפשת`, `מחפשים`, `מישהו מוכר`, `מישהו יש`, `קונה`,
   `צריך`, `WTB`, `looking for`, …). Never listed, never asked. Feeds buyer matches (7).
2. `strict`: at least one photo or video + an explicit price (`₪`, `ש"ח`/`ש״ח`/`שח`, `שקל`, `מחיר NNN`, `בNNN`/`ב-NNN`,
   thousands separators allowed) + a sale word (`למכירה`, `מוכר`, `מוכרת`, `נמכר?`, `במצב`, `כמו חדש`, `כולל`, …).
   This is the measured 100/100 rule. In shadow it is `wouldList: true`.
3. `ask`: not `wtb`, and either a photo + a bare number that reads as a price (`1300 מרכז`), or sale words + a price
   without a photo. These get the opt-in note but would not be auto-listed.
4. `none`: everything else (chatter, photo-only with no text, questions). No note.

Parsing (`parsed`): `price` (the matched string), `priceValue`, `title` (first line without the price, trimmed to 60
characters; missing for a bare price), `location` (first city/region from the list), `description` (the rest),
`isBundle` (two or more distinct prices; one listing, the whole text, first line as title; the AI may split later).

Repost merging: before asking, look for the same seller's listing with the same `textHash`, or token overlap ≥ 0.8,
created or refreshed within 30 days.
- If it is `live` or `expired`: no question. Refresh it (`refreshedAt = now`, status `live`, `messageIds` → the new
  message) and send a short note "Refreshed ✓" with the management buttons. The seller opted that item in already;
  reposting is the bump habit.
- If the seller declined the same text within 30 days: say nothing.
- In shadow, the merge target is logged as `mergeWith`.

### 6.4 Shadow mode and the hybrid gate

Every closed capture writes a `shadow_log` row, in every `captureMode` except `off`. The admin labels a sample in DM:

- `/label` (admin) sends one random unlabeled `wouldList: true` row: a `t.me/<group>/<messageId>` link (the group is
  public), the parsed title/price, and buttons ✅ Sale / ❌ Not a sale / ⏭ Skip. It sends the next row after each
  press. No member text is stored for this; the labeler reads the original in the group.
- `/stats` shows precision = sale / (sale + not_sale) over labeled rows, and the sample size.

**Gate for hybrid:** at least 100 labeled `wouldList` rows, drawn at random from at least 14 days of live traffic,
with precision ≥ 97% (at most 3 wrong in 100). The owner then decides; nothing flips automatically. Slice G then
adds `captureMode: hybrid`: `strict` and not a merge → listed at once with a note "Listed ✓ · Remove", `ask` → the
opt-in note as today.

### 6.5 The opt-in note

Sent when a capture closes with tier `strict` or `ask`, `captureMode` is `optin`, the sender's `askMode` is `ask`,
and the sender got fewer than 3 notes today. Plain text with an inline keyboard (not a rich message: plain text
renders on every client that shows notes at all). Sent with `sendMessage` + `ephemeral_message_parameters:
{ receiver_user_id }`, threaded like the post. The returned `ephemeral_message_id` is stored on the capture.

Complete post (title and price parsed):

> 🛒 להוסיף לשוק? **{title}** · {price} · {location}
> [➕ הוסף לשוק] [לא עכשיו] [אל תשאל אותי שוב]

Incomplete post (no title or no price): the first button is a URL deep link `t.me/<bot>?start=c_<captureId>`
("➕ השלם בבוט") instead of a callback, because a note can't collect text. The DM opens the wizard prefilled with
what was parsed, at the first missing step (8.2).

Buttons:
- **Add** → create a `group` listing from the capture (moderation in 9.2 applies), edit the note in place
  (`editEphemeralMessageText`) to the management card.
- **Not now** → capture `declined`, note deleted (`deleteEphemeralMessage`).
- **Don't ask again** → `members.askMode = "never"`, note edited to one line saying how to undo it (`/myposts` →
  settings, or `start=sell`).

A capture nobody answers becomes `ignored` when it expires. It is never asked again.

Management card (after Add, after Refresh, and wherever a note shows a listing):

> ✓ בשוק: **{title}** · {price}
> [🤝 נמכר] [🔄 רענון] [🗑 הסר] [⚙️ ניהול בבוט ↗]

The last button is a URL deep link `start=l_<listingId>`. It opens the DM listing card (durable), and it is how a
group-only member becomes a bot user.

### 6.6 Ownership and safety

Every listing callback checks `query.from.id == listing.sellerId` (moderator actions check `AuthLevel.MOD`). Notes are
private, but callback data is not a secret. A press on a note whose listing has ended edits the note to the ended
state instead of erroring. A note that fails to send is logged and the capture stays `classified`. Nothing retries:
the DM and `/myposts` are the fallback.

`ensureUserMiddleware` creates a `users` doc for anyone who presses any button, including a note button, without
having started the bot. That already happens for group buttons today. It means `/broadcastUsers` audiences can contain
people the bot can't DM. The existing failure report covers it; no change in 3.0.

### 6.7 The sweeper

One in-process scheduler (`setInterval`, started in the lifecycle `init`, stopped in `close`) runs idempotent jobs
against Mongo state:

| every | job |
|---|---|
| 10 s | close capture windows that are due; classify; write `shadow_log`; send notes |
| 10 min | lifecycle: nudges (11.1), expiry, queued catch-up offers past their window |
| 1 h | reconcile `bot` listings with `posts` (5.3); match new listings against saved searches if a send failed |

Each job claims its rows with an atomic `findOneAndUpdate` on state (the pattern of `claimPending`), so a second
process or an overlapping tick can't double-send.
`ponytail:` a single-process scheduler is enough for one bot instance. If the bot ever runs as more than one replica,
the atomic claims still hold, but the jobs should move to a leader or a queue.

## 7. Buyer matches

### 7.1 Trigger and matching

A closed capture with tier `wtb` runs a match against live listings (both sources).

Rules-only matching:
- normalize (lowercase, strip punctuation and niqqud, Hebrew final letters to regular, `ש״ח` variants unified);
- drop WTB, sale and stop words;
- expand aliases from the data file (`גלוק`↔`glock`, `אם 4`/`M4`, `AK`/`קלצ'ניקוב`, `GBB`, `AEG`, `HPA`, …);
- a listing matches when it shares at least one strong token (an alias-table term, or an alphanumeric token of 2+
  characters with a digit, such as `m4`, `g17`, `1911`) and, if the request names a ceiling (`עד 800`), its
  `priceValue` is at or under it.

Rank by token overlap, then `refreshedAt`. Show at most 5.

With `buyerMatches: shadow`, matches are logged on the `shadow_log` row (`matches: listingIds[]`) and nothing is sent,
so the owner can read a week of them in `/stats` before turning notes on. `/label` gets a second mode for match rows
(👍 useful / 👎 not).

### 7.2 The buyer note

With `buyerMatches: on`, one private note to the poster:

> 🔎 מצאתי בשוק {n} פריטים שמתאימים:
> • {title} · {price} · {location} ↗ (link to the group message, or to the bot's post)
> [🔔 התראה על חדשים ↗]

With zero matches: "עדיין אין בשוק משהו שמתאים" plus the same button. The button is a URL deep link
`start=s_<shadowId>`. The DM shows the parsed query, lets the buyer fix it in one reply, and saves the search.

Limits: one buyer note per poster per 6 hours. Never a note to someone with `askMode: never`.

### 7.3 Saved searches and alerts

When a listing goes `live` (created, relisted), it is matched against saved searches. Each hit gets one DM
(`alert_log` dedupes):

> 🔔 חדש בשוק, מתאים ל"{query}"
> {listing card}

For a `bot` listing the alert is a copy of the card. For a `group` listing it is a link to the message, plus media
when the file ids exist.

`/alerts` (DM, all users) lists searches with a 🗑 per row. At most 5 searches per user. A search expires after 60
days; 3 days before, the DM offers 🔄 Renew. A DM that fails with 403 (bot blocked) deletes that user's searches.

## 8. Listing through the bot (DM)

### 8.1 One message

In DM, a photo/video/album with a caption, sent while the user has no draft, starts a quick draft:

- Album items (`media_group_id`) are collected into one draft with the existing atomic `pushMedia`.
- The preview is sent 1.5 s after the last item. `ponytail:` that delay is an in-memory timer holding only the user
  id; all state is in the draft, so a restart only loses the preview send, and `/newpost` → Continue resends it.
- The caption is run through the same `classify`/parse as capture. `wtb` in DM means the user is a buyer: reply with
  matches and the save-search offer (7.2) instead of a draft.
- Preview = the existing preview rich message with [✅ פרסם] [✏️ כותרת] [✏️ מחיר] [✏️ מיקום] [✖️ ביטול]. A field
  button asks for that field only, reusing the wizard's step prompt and validation, then returns to the preview.
- Publish → the existing `createPost` path, then moderation (9.1).

If something required is missing (title, price, `minimumPhotos`), the draft goes to the first missing wizard step
instead of the preview. Text-only messages with no draft keep today's behaviour (a hint to send `/newpost`).

The draft is the existing `drafts` document. New optional fields only: `quick: true`, `mediaGroupId?`,
`captureId?` (8.2), so 2.0.1 can still read it.

### 8.2 Deep links

`/start <payload>` (the `start` command already receives args):

| payload | does |
|---|---|
| `sell` | "Send photos with a caption: what, price, where." Then 8.1. Used in the pinned post, the group description and Rose's join message (set by the owner, outside the bot). |
| `c_<captureId>` | Completes a captured post: a draft prefilled from the capture, first missing step, then Publish creates a `group` listing (not a bot post). If the capture has expired: say so and offer `sell`. |
| `l_<listingId>` | The seller's listing card in DM with Sold / Bump, and Remove for `group` listings (the durable twin of the note). |
| `s_<shadowId>` | Save-search flow (7.2). |

Unknown or foreign payloads fall back to the greeting.

### 8.3 `/myposts`

Lists both sources. Bot posts render exactly as today (existing `sold_`/`bump_` buttons). Group listings render
as one line each with a link and `ls_` buttons. Ended listings are grouped under a collapsed "ended" line with
Relist for `expired`. A settings row toggles `askMode`.

## 9. Moderation

### 9.1 Bot posts (trust-based, D4)

- **Trusted seller** = has at least one post that was ever approved (`approved` or `sold`) and no listing
  `taken_down` in the last 90 days. A query, not a stored flag. Only bot posts approved by a moderator count;
  captured listings never do (owner, Q1b).
- **New seller** → today's flow: moderation topic card with Approve / Reject.
- **Trusted seller** → published at once (the existing `handleApproval` path minus the click). The moderation topic
  gets a card "Published (trusted seller)" with [🚫 הסר מהשוק] (take down).

This changes the AGENTS.md rule "posts must pass through `moderationGroupId` before appearing in `approvedGroupId`".
After 3.0 they still pass through it, but for trusted sellers it is after publishing. Slice 1 updates AGENTS.md.

### 9.2 Captured listings

The member's post is already public and policed by the group's own moderators. The bot only decides whether it
enters the market (buyer notes, alerts). **Decided (owner, Q1):** live at once, and a new seller's first captured
listing gets a moderation-topic card with Take down (post-moderation), so moderators see each new seller once. No
`pending` listing status.

### 9.3 Reject needs a reason

Reject keeps the atomic claim. The prompt replaces Skip with preset reason buttons plus "Other: reply to this
message" (the existing reply-tracking path). Presets (owner, Q4), as `he` locale strings, with `en`/`ru`
translations:

1. חסר מחיר
2. תיאור ו\או תמונות לא ברורות
3. פריט לא חוקי
4. כפילות של מודעה קיימת - אפשר להקפיץ או להמתין

The author is told the reason, in their language, with two buttons: a one-tap "Fix and resend" deep link
`start=sell`, and a URL button to the group rules (`rulesUrl`, 5.4; no button when it is empty).
Callback `rr_<postId>_<n>`. The old `skip_reason_` buttons already in the moderation topic keep working through the
existing `handleSkip` (formats are frozen). New prompts just don't carry Skip.

### 9.4 Take down

`td_<listingId>` (MOD). It sets the listing `taken_down`, deletes the bot's group message for `bot` listings, and
tells the seller in DM if they are a bot user. A captured member's group message is not touched: deleting members'
messages stays a group-moderator action in Telegram.

## 10. Where the AI plugs in later (not built in 3.0)

`classify`/parse is a pure function with a fixed output shape (`ParsedListing`). When the owner's local AI server is
reachable, an optional enrichment step can run after a listing is created: write `ai.{title, model, condition,
category}` on the listing, re-tier `ask`/`none` captures, split bundles, and match by meaning in 7.1. It runs
asynchronously, and the rules result stays the fallback. Member text goes only to the owner's own server.
Nothing in 3.0 waits for it, and no interface is built for it ahead of time.

## 11. Listings that end

### 11.1 Nudge and expiry

- **Day 7** after `refreshedAt`, live listing, not on hold, no `nudgedAt`, `nudges` on → nudge once:
  - bot users get a DM card "עדיין למכירה?" [✅ עדיין למכירה] [🤝 נמכר], plus [🗑 הסר] for a `group` listing only;
  - group-only sellers get the same as a private note in the sale topic. Because a note sent to someone offline
    likely never arrives, a group-only seller's nudge is held until their next message in the group (the sweeper
    sends it then), and it falls back to plain expiry if they don't post again.
- "Still for sale" = refresh (`refreshedAt = now`, `nudgedAt` cleared).
- **Day 30** after `refreshedAt` → `expired`. No message (the nudge was the warning). A `bot` listing's group post
  is left as is; the post stays `approved` in `posts`.

### 11.2 Sold and Bump

- **Sold** (note, DM card, `/myposts`): `sold` everywhere. For a `bot` listing, the existing sold re-render in the
  group. For a `group` listing, the market only (the bot can't edit a member's message).
- **Bump**:
  - `bot` listings keep today's bump (re-post in the group, `dailyBumpLimit`) and also refresh the listing.
  - `group` listings: Bump is "🔄 Refresh". It resets the clock and moves the item up in matches, with no public post
    (D10). The seller's own repost in the group does the same automatically (6.3).

### 11.3 Trust signals on listings

- **Completed sales** = the seller's listings in `sold` (both sources, including the `sold` posts reconciled as
  `legacy`).
- **In the market since** = the earliest of `members.firstSeenAt`, `users.createdAt` and the seller's first post.
  Telegram gives bots no group join date, so the label says "in the market since", not "member since".

Shown as one line, "🤝 {n} מכירות · בשוק מאז {month year}", on new bot posts in the group, the DM cards, alerts and
buyer notes. It is left out when n = 0 and the seller is new, so a new seller isn't marked down. Existing group
messages are not re-rendered for it. `check-rich` keeps the old golden and gets a new one with the line.

### 11.4 The 14 stale sellers (D5): one message, owner-approved text

The reconcile creates `legacy` listings for the 28 posts. The one-time job (admin command `/stalecheck`, which shows
a dry-run count and the exact text first, then needs a second confirm) sends **one DM per seller** (they are all bot
users), listing their posts with buttons per post. The idea and "no answer in 7 days → leaves the market" are
approved (owner, Q2).

**Pilot first (owner):** `/stalecheck <userId> [userId…]` sends only to those sellers, so the owner can give the
sellers he knows a heads-up and treat them as beta testers. A later `/stalecheck` with no ids sends to the rest. The
send-once guard is per seller.

**Text:** the owner writes the final wording after seeing the real layout on the test bot ("Stale-check dry run (to
me only)", slice 3). It lives in the locale files. The draft below only fixes the layout and the placeholders:

> שלום {firstName} 👋
> כאן הבוט של קבוצת המכירות. אנחנו מסדרים את השוק, ויש לך אצלנו מודעות שמסומנות כפעילות כבר יותר מחודש:
> 1. {title} · {price} (מ־{date})
> 2. …
> מה המצב? לחיצה אחת לכל מודעה:
> [1 ✅ עדיין למכירה] [1 🤝 נמכר]
> [2 ✅ עדיין למכירה] [2 🤝 נמכר]
> זו הודעה חד־פעמית. מודעה בלי תשובה תוסר מהשוק בעוד 7 ימים. ההודעה בקבוצה נשארת כמו שהיא.

(Gloss: "Hi {name}, this is the sales group's bot. We're tidying the market, and you have listings marked active for
over a month: … What's the status? One tap per listing. This is a one-time message. A listing with no answer leaves
the market in 7 days. The group message stays as it is.")

- Answers: ✅ = refresh, 🤝 = Sold (also `post.status = "sold"` and the existing group re-render). No Remove: these
  are approved bot posts (5.2). A duplicate is marked Sold.
- No answer in 7 days → `expired` (listing only).
- A 403 (blocked) → `expired` at once.

The send log is kept on the listings (`nudgedAt`, `origin: legacy`), so the job refuses to run twice.

### 11.5 Catch-up scan (D6): last 30 days, go-ahead first

The bot can't read history, so this runs offline:

1. `scripts/catchup.ts` (run on the owner's laptop) reads the Telegram Desktop export JSON (owner's private folder,
   never in the repo). It groups posts (6.2), runs `classify`, merges reposts, and writes `catchup.json`: per seller,
   the user id and items `{messageId, title, price, location, text, tier}`. Tier `strict` and `ask` only; `wtb` is
   dropped. Expected size: about 131 items from 73 sellers.
2. The owner reviews `catchup.json` (`/stats`-style summary printed by the script).
3. `/catchup import` (admin, DM, the file attached) stores the offers on `members.pendingCatchup`. Nothing is sent.
4. `/catchup send` (admin, after the owner's go-ahead) arms delivery. Because notes to offline members likely never
   arrive, each seller's offer is delivered as a private note on their next message in the sale topic, within 30
   days. After that it is dropped. The idea and delivery on the next message are approved (owner, Q3). **The owner
   writes the final text after seeing the layout on the test bot ("Catch-up offer to me", slice 6).** The draft only
   fixes the layout:

   > 🛒 ראינו שפרסמת כאן לאחרונה {n} פריטים. להוסיף אותם לשוק של הבוט? כך קונים שמחפשים אותם יקבלו התראה.
   > [➕ בחר פריטים בבוט ↗] [לא תודה]

   The button deep-links `start=k_<memberId>`. The DM lists the items with ➕ per item, and each tap creates a
   `catchup` listing (live, `refreshedAt` = the original post date, so day-7 and day-30 count from the real post).

A seller who taps nothing gets nothing more. `catchup.json` and the export copy are deleted after import.

## 12. Metrics

`/stats` (admin, DM) shows these over the last 7 and 30 days. The baseline row comes from #104.

| metric | baseline (#104) | 3.0 target (8 weeks after `optin`) | source |
|---|---|---|---|
| Sale posts in the sale topic per month | ~250 | (context) | `shadow_log` tiers `strict`+`ask` |
| Bot share: market listings created ÷ sale posts | ~1–3% | ≥ 30% | `listings` ÷ `shadow_log` |
| Opt-in rate: Add ÷ notes sent | n/a | ≥ 40% | `captures` |
| Listings that end as sold | 28% (11 of 39 non-rejected posts) | ≥ 35% | `listings` |
| Listings older than 30 days still "for sale" | 28 posts | 0 | `listings` |
| Same-text reposts within 30 days | 39% of sale posts | below 25% | `shadow_log.mergeWith` |
| First-time sellers rejected / rejected without reason | 4 of 4 / 3 of 4 | rejects ≤ 25% / 0 | `posts` |
| Wanted-to-buy posts answered with a note | 0 | ≥ 90% when `on` | `shadow_log` |
| Saved searches active / alerts sent | 0 / 0 | ≥ 30 / (count) | `saved_searches`, `alert_log` |
| DM one-message listing, median time to Publish | 5 steps | < 30 s | `drafts.startedAt` → post `createdAt` |
| Shadow precision (gate for hybrid) | 100/100 on export | ≥ 97% on ≥ 100 live | `shadow_log` labels |

Targets are guesses for the owner to adjust. The point is to see every number from day one, because slice 0 starts
counting before anything changes.

## 13. Slices

Each slice is its own PR to master, its own release and its own deploy (owner's go-ahead). Each needs a mongodump
first (docs/BACKUP.md) and a census diff after. Rollback = redeploy the previous image; every slice leaves 2.0.1 able
to run. Version numbers are the builder's call: proposed 3.0.0 for slices 0+1 together (moderation changes behaviour),
then a minor per slice.

**Every slice's test plan has three layers:**

1. **`check-*` scripts** (`pnpm test`; Mongo-gated ones need a throwaway `mongo:8.2`).
2. **In-bot `/test` cases** (admin, test bot), each listed below.
3. **Synthetic updates on the test bot:** the harness feeds `bot.handleUpdate` group messages "from" the owner's user
   id (278683632) in the user-facing test group, topic 73. A fetch wrapper fakes only `answerCallbackQuery`, and the
   real sends and edits go to the test groups. Only typing into DM flows needs the owner; ask the owner for visual
   glances only.

Test fixtures are hand-written Hebrew/English sale, wanted-to-buy and chatter texts in the style of the export. They
contain no member names, phone numbers or copied posts.

### Slice 0: market core + shadow (invisible to members)

- **Scope:** `listings`, `captures`, `shadow_log`, `members`; reconcile from `posts`; capture middleware, windows and
  sweeper; `classify`/parse + data file; repost detection; `captureMode` (`off`/`shadow`), `buyerMatches`
  (`off`/`shadow`) with WTB match logging; `/label`, `/stats`. The banned-word check in `check-locals`.
- **Checks:**
  - new `check-classifier` (no Mongo): fixture table → tier and parsed fields, every price format in 6.3, WTB
    precedence, bundles, bare price.
  - new `check-market` (Mongo): window grouping incl. album + separate text within 90 s, close timing with a fake
    clock, repost merge, reconcile idempotence, atomic claims under two concurrent sweeps, TTL indexes exist.
  - `check-routes`: group messages outside the sale topic and from bots are ignored.
  - `check-locals`: no `he` string contains a blocked word (5.5).
  - `check-classifier`: a post containing a blocked word is tier `none`, including the "לנשק" false positive.
- **/test:** "Classify text" (reply with tier and parse), "Shadow: last 5 rows".
- **Synthetic:** 20 fixture posts into topic 73 → `shadow_log` rows match expected tiers; nothing sent to the group.
- **Exit:** deployed with `captureMode: shadow`; a week of `/stats` gives the live baseline.

### Slice 1: trust-based moderation + reject reasons + take down

- **Scope:** 9.1, 9.3, 9.4; the blocked-word check at the wizard preview (5.5), shipped with trust because trusted
  posts skip review; AGENTS.md rule update.
- **Checks:**
  - `check-flows`: new seller → moderation card; trusted → instant publish + take-down card; take down within 90 days
    → not trusted; preset reason → author notified with that reason; old `skip_reason_` still works; a title with
    "לנשק" stops at the preview and asks for the title again.
  - `check-callbacks`: `rr_`, `td_` pinned.
  - `check-claim`: concurrent preset-reason presses.
- **/test:** "Post as trusted seller", "Post as new seller".
- **Synthetic:** reject via preset on a test post in moderation topic 15.

### Slice 2: opt-in capture notes

- **Scope:** 6.5, 6.6, `captureMode: optin`, `members.askMode`, `start=c_` and `start=l_`, `/myposts` for both
  sources, ownership checks.
- **Checks:**
  - `check-flows`: Add / Not now / Don't ask again, incomplete → deep link → prefilled wizard → `group` listing;
    a foreign user's press refused; 3 notes/day cap; declined text not asked again.
  - `check-callbacks`: `mk_`, `ls_` pinned; callback data ≤ 64 bytes.
- **/test:** "Send me a capture note" (a real note to the presser in topic 73).
- **Synthetic:** fixture post → real note → press Add with a faked callback → note edited.
- **Owner gate before prod `optin`: a second account confirms that other members don't see the note** (still
  unverified in #104).

### Slice 3: listings that end + the 14 stale sellers

- **Scope:** 11.1–11.4, Relist, the trust line on new cards, `/stalecheck` (dry run, then confirm).
- **Checks:**
  - `check-market`, with a fake clock: nudge at day 7 exactly once, refresh clears it, expiry at day 30, held nudge
    sent on the next group message; `bot` Sold also sets post `sold`; reconcile after a simulated 2.0.1 sell;
    no card for a `bot` listing offers Remove.
  - `check-rich`: the old golden is unchanged; a new golden with the trust line.
- **/test:** "Age my test listing 7 days", "Age 30 days", "Stale-check dry run (to me only)".
- **Synthetic:** the stale DM sent to the owner only, from a seeded test DB.
- **Owner gate:** the owner's final text (after the dry run), then the pilot send, then the rest. Slice 3 can deploy before that: legacy
  listings stay on hold and `nudges` stays off until the owner turns it on.

### Slice 4: buyer matches + saved searches

- **Scope:** 7; `buyerMatches: on`; `/alerts`; `start=s_`.
- **Checks:**
  - `check-classifier`: alias normalization, ceiling parse.
  - `check-market`: matching ranks fixtures as expected; `alert_log` dedupe; 403 deletes searches; expiry and renew.
- **/test:** "Match for text", "Alert me now for my saved searches".
- **Synthetic:** WTB fixture in topic 73 → buyer note to the owner; publish a matching test listing → DM alert.
- **Exit:** a week of `shadow` matches reviewed in `/label` before `on`.

### Slice 5: one-message DM listing

- **Scope:** 8.1, `start=sell`, the field-edit buttons.
- **Checks:**
  - `check-flows`: album of 3 + caption → one draft and one preview; missing price → price step; WTB caption in DM →
    buyer reply; restart between album and preview → Continue resends.
  - `check-callbacks`: new draft buttons pinned and added to the stale-button prefixes.
- **/test:** "Quick draft from caption text".
- **Live:** the owner sends one real album to the test bot (typing needs the human).

### Slice 6: catch-up scan

- **Scope:** 11.5: script, `/catchup import`, `/catchup send`, `start=k_`.
- **Checks:**
  - script unit check on a synthetic export JSON (no real data): grouping, tiers, merge.
  - `check-market`: offer held until the next message, dropped after 30 days, never twice.
- **/test:** "Catch-up offer to me".
- **Owner gates:** review of `catchup.json`, the owner's final text (after "Catch-up offer to me"), the go-ahead to
  send.

### Slice G (after 3.0, only if the gate in 6.4 passes)

- **Scope:** `captureMode: hybrid`, the "Listed ✓ · Remove" note, `/stats` before/after.

## 14. What is left to the builder

- Exact word lists, alias table and city list (start from the export's vocabulary; keep them in the data file).
- Locale wording for en/ru and all Hebrew strings not quoted here (owner reviews them in the PR). No blocked word in `he` (5.5).
- Index details, field names beyond the ones listed, the module split inside `src/services/` (e.g. `classifier`,
  `captureService`, `marketService`, `lifecycleService`, `matchService`), as long as Mongoose stays in repositories.
- Callback prefixes and payload spellings (the ones here are proposals), pinned in `check-callbacks` once shipped.
- Release numbering per slice.

## 15. Calls made in this design (owner may overturn)

- Captured listings live in a new `listings` collection, not in `posts` (rollback safety).
- The note is plain text with buttons, not a rich message.
- The capture window closes 30 s after the last message (within the measured 90 s).
- `shadow_log` stores no member text. `captures` keeps text for 7 days only.
- An unanswered note is never re-asked. At most 3 notes per seller per day, and 1 buyer note per 6 hours.
- Notes and nudges to group-only members are held until their next message in the group, because a note to an
  offline member likely never arrives.
- Bump on a captured listing is a market refresh, never a public post.
- Expired listings are left alone in the group. Sold `bot` posts get today's strikethrough.
- Trust = an approved bot post ever, revoked for 90 days by a take-down.
- The trust line is hidden for brand-new sellers.
- Removed and taken-down listings lose their text and media.
- Hybrid is not built until the gate passes.
- Day counts, window and limits are constants, not config. The only new config keys are the switches `captureMode`,
  `buyerMatches` and `nudges`, plus `rulesUrl`.
- The rules link is a button on the author's reject notice, not on the moderator's reason prompt.
- `/stalecheck` can send to a pilot list of user ids first (11.4). The pilot's ids stay out of this public repo.
- The 28 legacy listings stay on hold (no nudge, no expiry, not in matches) until `/stalecheck` sends.
- A member deleting their own group post is invisible to the bot: Telegram sends no update. In 3.0 such a listing
  stays live until Sold, the day-7 nudge or the day-30 expiry. Buyer notes and alerts show the post date so an old
  link reads as old. A liveness check (copying the message to a private log chat before a match is shown) is left for
  later, if `/stats` shows dead links are common.

## 16. Open questions for the owner

Answered:
- Q1. Captured listings from new sellers go live at once, with a moderator take-down card (9.2).
- Q1b. Captured listings don't count toward trust. Trust comes only from a moderator-approved bot post (9.1).

- Q2. The stale-seller message is approved as an idea, with a pilot first. The owner writes the text at slice 3 (11.4).
- Q3. The catch-up offer is approved as an idea. The owner writes the text at slice 6 (11.5).
- Q4. The preset reasons are the owner's four, plus a group-rules button (9.3).

None left open.
