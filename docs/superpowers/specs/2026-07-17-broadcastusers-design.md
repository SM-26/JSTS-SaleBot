# `/broadcastUsers` — direct-message broadcast to bot users

## Context

The bot has `/broadcast`, which posts a message to the approved **channel**.
There is no way to reach individual users directly. The admin needs to send a
private message (PM) — e.g. "the bot is down for maintenance" — to the people
who are actually using the bot right now or have posts in flight.

`/broadcastUsers` fills that gap: an admin-only command that DMs a message to
the union of three audiences — users mid-session, authors of pending posts,
and authors of approved posts — de-duplicated.

This is distinct from `/broadcast` (channel post). Different target, different
delivery (individual DMs vs. one channel message).

## Requirements

- **Auth:** ADMIN only (`AuthLevel.ADMIN`), same gate as `/broadcast`.
- **Audience:** always all three groups at once — active-session users +
  pending-post authors + approved-post authors — merged and de-duped. No
  per-send segment selection.
- **Self-exclude:** the initiating admin is removed from the recipient list
  (no self-DM of the maintenance notice).
- **Message input:** mirrors `/broadcast` — reply to a message *or* inline
  text (`/broadcastUsers your text`), rendered as HTML. **Text-only**: a
  replied-to media message with no text is rejected.
- **Timing:** send immediately (no confirmation step).
- **Report:** after sending, report to the admin who was reached and who
  failed, with a per-recipient reason for each failure. The report is sent to
  the admin as a **Rich Message** (heading + summary + failures list),
  consistent with `/help` and the post views.
- **Private chat only**, like `/broadcast`.

### Non-goals (explicitly out of scope)

- Media fan-out (copying a photo/video to each recipient). Text only.
- Selectable/segmented targeting.
- Persisting "active users" across restarts — active is intentionally the
  in-memory session set; a restart clearing it is acceptable.

## Architecture

Approach: a focused service owns the mechanics; the controller orchestrates
and presents.

```
/broadcastUsers ──▶ BotController.handleBroadcastUsers(msg, args)
                      │  auth-check (ADMIN), parse message (reply-to/inline)
   this.sessions ────┤  activeIds = !isIdle session ids (String)
                      ▼
        broadcastUsersService.resolveAudience(activeIds, excludeId)
                      │  ├─ postRepository.distinctUserIdsByStatus("pending")
                      │  └─ postRepository.distinctUserIdsByStatus("approved")
                      ▼  de-duped userIds[] (minus excludeId)
        broadcastUsersService.sendToMany(userIds, htmlMessage)
                      ▼  BroadcastReport { total, sent, failures[] }
        BotController enriches failures with @username, formats,
        sends localized report ──▶ admin
```

**Responsibility split:** the service is *mechanics* (who to send to, how to
send, what failed). It never reads `sessions` (receives IDs) and never formats
user-facing text. The controller is *presentation* (auth, message parsing,
localized report, username enrichment).

### New file: `src/services/broadcastUsersService.ts`

```ts
interface BroadcastFailure { userId: string; reason: string; }
interface BroadcastReport { total: number; sent: number; failures: BroadcastFailure[]; }

class BroadcastUsersService {
  constructor(private bot: TelegramBot) {}

  // Merge active-session ids with pending/approved post authors, de-dupe,
  // drop excludeId (the initiating admin). Returns distinct user ids.
  async resolveAudience(activeIds: string[], excludeId: string): Promise<string[]>;

  // Throttled sequential fan-out. Never aborts on a single failure.
  async sendToMany(userIds: string[], htmlMessage: string): Promise<BroadcastReport>;
}
```

`resolveAudience` runs the two DB queries with `Promise.all`, merges with the
passed-in `activeIds` via a `Set`, removes `excludeId`.

### New repo method: `postRepository.distinctUserIdsByStatus`

```ts
distinctUserIdsByStatus(status: IPost["status"]): Promise<string[]> {
  return Post.distinct("userId", { status });
}
```

One method covers both `"pending"` and `"approved"` — returns author ids
directly, no need to fetch full post documents.

### New method: `BotController.handleBroadcastUsers(msg, args)`

Thin orchestration, next to `handleActiveUsers` (which already reads
`sessions`). Steps: admin auth → resolve the message text (reply-to text or
inline `args`; reject media-only) → compute `activeIds` from `sessions`
(`!isIdle`, `String(id)`) → `resolveAudience` → `sendToMany` → enrich failures
with usernames (one `userRepository.findManyByIds(failedIds)`) → format and
send the localized report.

## Delivery mechanics

- **Throttle:** send sequentially with a ~50 ms gap (~20/sec), comfortably
  under Telegram's ~30 msg/sec ceiling. No parallel batching.
  `// ponytail: fixed 50ms throttle; batch/parallelize only if audience grows large`
- **Per recipient:** `bot.sendMessage(Number(userId), htmlMessage, { parse_mode: "HTML" })`
  in try/catch. A failure is captured and the loop continues.
- **Error → reason mapping** (`mapSendError`, a pure function):

  | Telegram error                         | Reported reason           |
  | -------------------------------------- | ------------------------- |
  | 403 (blocked / bot kicked)             | "blocked the bot"         |
  | 400 "chat not found"                   | "hasn't started the bot"  |
  | 429                                    | "rate limited"            |
  | anything else                          | raw Telegram description  |

- **Report shape:** `{ total, sent, failures: [{ userId, reason }] }`. The
  service returns ids + reasons only; the controller adds `@username`.
- **Long failure lists:** the report always shows the count summary, itemizes
  the first ~30 failures, then appends "…and N more (see logs)." The full
  failure list is written to `console` regardless.

### Report presentation (Rich Message)

The controller sends the admin report via `bot.sendRichMessage`, matching the
loose-typed block-building style already used in `postService`/`showHelp`
(assemble blocks, cast once at the boundary):

- `heading` — the report title (e.g. "📢 Broadcast report"), size 2.
- `paragraph` — the summary line (`broadcastUsersReport`: sent / failed / total).
- If there are failures: a `divider`, then a `list` of failure items
  (`• @username (id) — reason`, up to ~30), and a trailing `paragraph` with
  `broadcastUsersMore` when truncated.

If there are zero failures, only the heading + summary paragraph are sent.

## Command routing

`/broadcast` is currently registered as `/\/broadcast([\s\S]*)/`. This **also
matches** `/broadcastUsers`, and `node-telegram-bot-api` fires every matching
`onText` handler — so without a fix, `/broadcastUsers …` would additionally
trigger the channel broadcast. Required fix:

- Tighten `/broadcast` to `/\/broadcast(?!Users)([\s\S]*)/` (negative
  lookahead; identical capture behavior, no longer matches `/broadcastUsers`).
- Register `/\/broadcastUsers([\s\S]*)/` → `handleBroadcastUsers`, private-only.

## Edge cases

1. Not admin → `notAdmin`.
2. No message (no reply-to, no inline text) → `broadcastUsersUsage`.
3. Replied-to message is media-only (no text) → `broadcastUsersTextOnly`.
4. Empty audience (nobody active, no pending/approved authors after
   self-exclude) → `broadcastUsersNoRecipients`, nothing sent.
5. Partial/total failure → itemized report (above).

## Locale keys (add to en/he/ru + `LocaleStrings`)

- `helpBroadcastUsers` — line for the `/help` admin section (already a Rich
  Message; add to the admin `list` block in `showHelp`).
- `broadcastUsersUsage`
- `broadcastUsersTextOnly`
- `broadcastUsersNoRecipients`
- `broadcastUsersReport` — e.g. `"📢 {sent} sent, {failed} failed (of {total})."`
- `broadcastUsersMore` — e.g. `"…and {n} more (see logs)."`

Failure lines (`• @user (id) — reason`) are data, built inline, not localized.

## Testing

Match the project's conventions (no test framework; `pnpm test` runs
`checkLocals.ts`; `testCases.ts` is a ts-node manual harness).

- **Automated (pure logic):** `src/tests/broadcastUsers.check.ts`, a ts-node
  `assert` script (like `checkLocals.ts`) covering the two fiddly pure
  functions, kept free of bot/DB deps:
  - `mapSendError` — fake 403 / 400 "chat not found" / 429 / unknown errors →
    assert the mapped reason strings.
  - report truncation — 80 fake failures → assert 30 itemized + "…and 50 more".
- **Integration (needs bot + DB), via the `/test` harness:** add a
  `broadcast_users` case to `TEST_CASES` in `testCases.ts` that seeds a pending
  post and an approved post (distinct authors) and invokes the audience
  resolution / send path, so it can be exercised in the running bot.
- **Manual, via Docker run:** seed pending + approved posts from different
  accounts, run `/broadcastUsers test`, confirm: report count matches the
  de-duped audience, the sender is excluded, a user who blocked the bot shows
  as a failure with "blocked the bot", and `/broadcastUsers` posts **nothing**
  to the channel (route-collision check).
