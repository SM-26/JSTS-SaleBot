# Slice 0: Market Core + Shadow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the bot a market memory (`listings`, `captures`, `shadow_log`, `members`) and a shadow classifier that watches the sale topic and logs what capture would do, with nothing visible to members.

**Architecture:** New Mongoose models and repositories beside the existing ones. A pure `classify` service shared by every later slice. A capture middleware upserts group messages into per-sender windows. An in-process sweeper closes windows, classifies them and writes `shadow_log`, and an hourly reconcile mirrors `posts` into `bot` listings. `/label` (ADMIN) and `/stats` (MOD) read the shadow data.

**Tech Stack:** TypeScript, node-telegram-bot-api 2.3.0 (v2 middleware chain), mongoose 9, Node stdlib `crypto`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-market-design.md` (sections 5, 6, 7.1, 12, 13 "Slice 0"). Read it before Task 1.

## Global Constraints

- Branch `feat/slice0-market-core` from `origin/master` (master already has ntba 2.3.0). One PR to master; don't merge without the owner.
- Follow `Agents.md` (the repo's file is named `Agents.md`): services hold logic, repositories hold every Mongoose query, types in `src/types/index.ts`, no `any`, `[ERROR - <context>]` logs, v2 params-object API calls.
- Additive data only: new collections, no change to `posts`/`users`/`drafts`/`bot_sessions` documents. The 2.0.1 image must still run against the database.
- Nothing is sent to the group or to any member in this slice. `captureMode` and `buyerMatches` only accept `off` / `shadow` here (`optin`/`on` come in slices 2 and 4).
- Constants in code, not config: window 90 s, quiet close 30 s, captures TTL 7 days, shadow_log TTL 120 days, repost window 30 days, token overlap threshold 0.8, max matches 5, sweeper ticks 10 s and 1 h.
- Blocked words: Hebrew substring match on `["נשק"]`, from `src/config/blockedWords.json`. No `he` locale string may contain one.
- Every new user-facing string goes into `en`, `he` and `ru` `common.json`. The owner rewrites user-facing text later (standing exception), so keep the wording plain and short. Hebrew must never call replicas weapons.
- Callback formats are frozen once shipped. New prefixes are pinned in `src/tests/checkCallbackData.ts`, and every callback_data stays ≤ 64 bytes.
- Tests never use the production token or database. Mongo-gated checks run against a throwaway `mongo:8.2` (`docker run -d --rm --name s0-mongo -p 127.0.0.1:27030:27017 mongo:8.2`, `MONGO_URI=mongodb://127.0.0.1:27030/SalesBotTestDB`). A run that prints `[SKIP]` for them is not a pass.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the executing model's line).

## Review Focus

1. **Prod sale topic has no thread id.** In prod `approvedTopicId` is 1, and sale-topic messages arrive with no `message_thread_id` (or 1). They must be captured, and General (48138) and other topics must not. Test: Task 6 `topic 1 accepts missing thread id`.
2. **Album with the caption on a later item, or text sent separately after the photos.** All of it should become one capture, with the text found. Test: Task 6 `album then separate text joins one window`.
3. **Restart mid-window.** A window opened before a restart must still close and classify. Since windows live in Mongo, test it by closing with a fresh repository call and an injected clock: Task 7 `window closes after restart`.
4. **A sweeper tick that throws** (Mongo blip, bad document) must log and leave the next tick working, never crash the process. Test: Task 7 `failing job does not stop the scheduler`.
5. **Photo with no caption, or a 4,000-character caption.** Tier `none` for the first, no crash and a 60-character title for the second. Test: Task 3 fixtures `photo-only` and `long caption`.

---

### Task 1: Config keys and the `string` config kind

**Files:**
- Modify: `src/types/index.ts` (`BotConfig`)
- Modify: `src/services/configSchema.ts`
- Modify: `config.json.example`
- Modify: `src/tests/configSchema.check.ts`, `package.json` (scripts)

**Interfaces:**
- Produces: `BotConfig.captureMode?: "off" | "shadow" | "optin"`, `BotConfig.buyerMatches?: "off" | "shadow" | "on"`, `BotConfig.nudges?: boolean`, `BotConfig.rulesUrl?: string`. All four are optional on the type (an old `config.json` lacks them). Code treats a missing key as `off` / `off` / `false` / `""`.
- Produces: `ConfigFieldSpec` gains `{ kind: "string"; pattern?: RegExp; allowEmpty?: boolean }`. `rulesUrl` is `{ kind: "string", pattern: /^https:\/\/t\.me\//, allowEmpty: true }`.
- `CONFIG_SCHEMA.captureMode` = enum `["off", "shadow"]` and `buyerMatches` = enum `["off", "shadow"]` for now (later slices extend the arrays). `nudges` is boolean.

- [ ] **Step 1: Write the failing assertions** in `src/tests/configSchema.check.ts`:
  `parseConfigValue("captureMode","shadow")` → `{ok:true,value:"shadow"}`; `("captureMode","optin")` → `ok:false`; `("buyerMatches","off")` → ok; `("nudges","true")` → `true`; `("rulesUrl","https://t.me/airsoft_yad2/54833/115880")` → ok with that string; `("rulesUrl","")` → `{ok:true,value:""}`; `("rulesUrl","http://evil.example")` → `ok:false`.
- [ ] **Step 2: Add the script** `"check-config": "ts-node src/tests/configSchema.check.ts"` and put it in `test` right after `check-locals`. Run `pnpm run check-config`. Expected: FAIL on the new assertions.
- [ ] **Step 3: Implement** the four keys and the `string` kind in `parseConfigValue` (trim, and when the value is empty, return `ok` if `allowEmpty`, otherwise test it against `pattern`). Add the keys to `config.json.example` with `"captureMode": "shadow"`, `"buyerMatches": "shadow"`, `"nudges": false`, `"rulesUrl": ""`.
- [ ] **Step 4: Run** `pnpm run check-config && pnpm run build`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(config): market switches and string config kind`.

### Task 2: Blocked words

**Files:**
- Create: `src/config/blockedWords.json` (`["נשק"]`)
- Create: `src/services/blockedWords.ts`
- Modify: `src/tests/checkLocals.ts`

**Interfaces:**
- Produces: `findBlockedWord(text: string | undefined | null): string | null`, which returns the first word from the list that `text.includes()`, or `null`.

- [ ] **Step 1: Write the failing test.** Add a section to `checkLocals.ts` that loads `he/common.json` (and `he/faq.json` if present) and fails (`hasError = true`, with the key named) for any value where `findBlockedWord(value)` is non-null. Add inline asserts: `findBlockedWord("מוכר נשק")==="נשק"`, `findBlockedWord("לנשק")==="נשק"` (the accepted false positive), `findBlockedWord("M4 למכירה")===null`, `findBlockedWord(undefined)===null`.
- [ ] **Step 2: Run** `pnpm run check-locals`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `blockedWords.ts`. Import the JSON (`resolveJsonModule` is already on, or check `tsconfig.json`). Add `// ponytail: substring match on purpose (owner): letters, not meaning`.
- [ ] **Step 4: Run** `pnpm run check-locals`. Expected: PASS. If an existing `he` string contains נשק, fix the string, not the check.
- [ ] **Step 5: Commit** `feat: blocked-word list and locale check`.

### Task 3: Classifier

**Files:**
- Create: `src/services/classifier.ts`
- Create: `src/services/classifierData.json`
- Create: `src/tests/checkClassifier.ts`, with the script `check-classifier` added to `test` after `check-config`

**Interfaces:**
- Produces (exported from `classifier.ts`):
  - `type Tier = "wtb" | "strict" | "ask" | "none"`
  - `interface Parsed { title?: string; price?: string; priceValue?: number; location?: string; description?: string; isBundle: boolean }`
  - `interface ClassifyResult { tier: Tier; rules: string[]; parsed: Parsed }`. `rules` holds rule ids such as `"wtb-opener"`, `"has-media"`, `"price-currency"`, `"price-b-prefix"`, `"price-bare"`, `"sale-word"`, `"blocked-word"`.
  - `classify(text: string, hasMedia: boolean): ClassifyResult`
  - `normalize(text: string): string`: lowercase; strip punctuation and niqqud; final letters ך ם ן ף ץ → כ מ נ פ צ; unify `ש״ח`/`ש"ח`/`שח` to `שח`; collapse whitespace.
  - `tokens(text: string): string[]`: normalized, with WTB, sale and stop words dropped, and alias expansion applied (each alias group maps to its first member).
  - `textHash(text: string): string`: sha1 hex of `normalize(text)`.
  - `tokenOverlap(a: string[], b: string[]): number`: |a∩b| / min(|a|,|b|), and 0 when either is empty.
- `classifierData.json` keys: `wtbOpeners`, `saleWords`, `stopWords`, `cities`, `aliases` (array of string arrays). Seed them from spec 6.3 and 7.1: openers `מחפש מחפשת מחפשים "מישהו מוכר" "מישהו יש" קונה צריך wtb "looking for"`; sale words `למכירה מוכר מוכרת נמכר במצב "כמו חדש" כולל`; aliases `["glock","גלוק"]`, `["m4","אם 4","אם4"]`, `["ak","קלצניקוב","קלאץ"]`, `["gbb"]`, `["aeg"]`, `["hpa"]`; cities `תל אביב`, `ירושלים`, `חיפה`, `באר שבע`, `נתניה`, `ראשון לציון`, `פתח תקווה`, `השרון`, `מרכז`, `צפון`, `דרום`, `שפלה`.
- Tier rules, first match wins (spec 6.3):
  1. `findBlockedWord(text)` → `none` with rule `blocked-word`.
  2. A WTB opener in the first line → `wtb`.
  3. `hasMedia` + explicit price (`₪`, `שח` variants, `שקל`, `מחיר NNN`, `בNNN`/`ב-NNN`, with thousands separators) + a sale word → `strict`.
  4. (`hasMedia` + a bare 2–6 digit number) or (a sale word + an explicit price, no media) → `ask`.
  5. Otherwise `none`.
- Parsing: `price` is the matched string; `priceValue` is its number (commas removed); `title` is the first line minus the price, trimmed and cut to 60 chars, and is unset when the first line is only a price; `location` is the first city found; `description` is the remaining lines; `isBundle` is true when there are 2+ distinct price values.

- [ ] **Step 1: Write the failing fixture table** in `checkClassifier.ts` as `Array<[name, text, hasMedia, expectedTier, partialParsed?]>`, with hand-written texts (no copied posts). It needs at least these rows:
  - `"strict ₪"`: `"גלוק 17 למכירה\nבמצב מעולה\n1,300₪ מרכז"`, media → `strict`, `{priceValue:1300, location:"מרכז", title:"גלוק 17 למכירה"}`
  - `"strict שח"`: `"M4 למכירה 900 ש\"ח"` → `strict`, priceValue 900
  - `"strict ב-"`: `"מוכר וסט ב-250 כמו חדש"` → `strict`, 250
  - `"wtb first line beats price"`: `"מחפש M4 עד 800₪"`, media → `wtb`
  - `"wtb english"`: `"WTB glock 19"` → `wtb`
  - `"ask bare price"`: `"1300 מרכז"`, media → `ask`, and `title` undefined
  - `"ask no photo"`: `"למכירה כוונת 300₪"`, no media → `ask`
  - `"bundle"`: `"למכירה\nM4 900₪\nגלוק 600₪"`, media → `strict`, `isBundle: true`
  - `"photo-only"`: `""`, media → `none`
  - `"chatter"`: `"מישהו יודע מתי המשחק?"` → `none`
  - `"blocked"`: `"מוכר נשק 500₪"`, media → `none`, with rules including `blocked-word`
  - `"blocked false positive"`: `"מתנה לנשק 500₪ למכירה"`, media → `none`
  - `"long caption"`: `"למכירה " + "א".repeat(4000) + " 500₪"`, media → `strict`, `title.length <= 60`

  Also assert `normalize("ש״ח")===normalize("ש\"ח")`, `textHash(a)===textHash(a + "  ")`, `tokenOverlap(tokens("גלוק 17 למכירה"), tokens("glock 17"))>=0.8`, and `tokenOverlap([], ["x"])===0`.
- [ ] **Step 2: Run** `pnpm run check-classifier`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `classifier.ts` with the signatures above. It is pure: no I/O apart from the JSON import.
- [ ] **Step 4: Run** `pnpm run check-classifier`. Expected: every row prints `[OK]`, and the script exits 0.
- [ ] **Step 5: Commit** `feat: rules classifier with fixtures`.

### Task 4: Market models and repositories

**Files:**
- Create: `src/models/Listing.ts`, `src/models/Capture.ts`, `src/models/ShadowLog.ts`, `src/models/Member.ts`
- Create: `src/repositories/listingRepository.ts`, `captureRepository.ts`, `shadowLogRepository.ts`, `memberRepository.ts`
- Create: `src/tests/checkMarket.ts` (Mongo-gated; script `check-market` added to `test` after `check-flows`)

**Interfaces (later slices depend on these names; don't rename them):**
- `IListing` follows spec 5.3 exactly, plus `hold: boolean` (default false). Enums: `source: "bot" | "group"`, `origin: "dm" | "capture" | "catchup" | "legacy"`, `status: "live" | "sold" | "expired" | "removed" | "taken_down"`, `endedBy?: "seller" | "moderator" | "system"`. Indexes: `{status:1, refreshedAt:1}`, `{sellerId:1, status:1}`, `{source:1, postId:1}` (unique, partial on `postId` existing), `{chatId:1, messageIds:1}`. Collection `listings`.
- `ICapture` follows spec 5.3 with `state: "open" | "closed" | "classified" | "asked" | "added" | "declined" | "ignored"` (`closed` is added here: claimed by the sweeper, not yet classified), `mediaGroupIds: string[]`, `tier?: Tier`, `parsed?: Parsed`, `rules?: string[]`. Indexes: TTL `{lastAt:1}` with `expireAfterSeconds: 7*24*3600`; unique `{chatId:1, senderId:1}` with `partialFilterExpression: {state:"open"}`; `{state:1, lastAt:1}`. Collection `captures`.
- `IShadowLog` follows spec 5.3 plus `matches?: string[]` (listing ids, spec 7.1) and `parsedTitle?: string`, `parsedPrice?: string` (shown by `/label`; these are parsed fields, not member text). TTL `{at:1}`, 120 days. Collection `shadow_log`.
- `IMember`: `{ userId, firstSeenAt, askMode: "ask" | "never", lastNoteAt?, pendingCatchup? }`, unique `{userId:1}`. Collection `members`.
- `listingRepository`:
  - `findByPostId(postId: string): Promise<IListing | null>`
  - `createForPost(post: Post, origin: "dm" | "legacy", hold: boolean, now: Date): Promise<IListing>`, which copies title, price, location, text and media from the post, with `sellerId = post.userId`, `source:"bot"`, `status:"live"`, `createdAt = refreshedAt = now`
  - `markSold(id: string, now: Date): Promise<IListing | null>`, only from `live` or `expired`
  - `findLiveForMatching(): Promise<IListing[]>`: `status:"live", hold:false`
  - `findSellerRecent(sellerId: string, since: Date): Promise<IListing[]>`: `live` or `expired`, `refreshedAt >= since`
  - `countByStatus(since?: Date): Promise<Record<string, number>>`
- `captureRepository`:
  - `appendMessage(input: CaptureMessageInput, now: Date): Promise<ICapture>`, with `CaptureMessageInput = { chatId: number; senderId: string; senderName: string; messageId: number; text?: string; entities?: StoredEntity[]; media: IMediaItem[]; mediaGroupId?: string }`. Algorithm: find the sender's open capture. If it exists and (`now - firstAt <= 90 s` or `mediaGroupId` is in its `mediaGroupIds`), push into it atomically. Text concatenates with a `\n`, and the first non-empty text wins as the head. If it exists but is too old, set it `closed`, then insert a new one. When there's none, insert. On a duplicate-key error (E11000, a concurrent album item), retry the whole call once.
  - `claimDue(now: Date): Promise<ICapture | null>`: one atomic `findOneAndUpdate` from `open` to `closed` where `lastAt <= now-30 s` or `firstAt <= now-90 s`
  - `claimClosed(): Promise<ICapture | null>`: one atomic claim of a `closed` capture with no `tier`. It sets a `classifyingAt` marker so that two sweepers can't both process it.
  - `saveClassification(id, tier, rules, parsed): Promise<void>`, which sets `state:"classified"`
  - `reparseOpen(chatId, messageId, text): Promise<ICapture | null>`: on edit, replace that message's text in an open capture
- `shadowLogRepository`:
  - `insert(row: Omit<IShadowLog, "_id">): Promise<IShadowLog>`
  - `sampleUnlabeled(): Promise<IShadowLog | null>`: `$sample` size 1 over `wouldList:true`, with no label
  - `setLabel(id, label: "sale" | "not_sale", by: string, now: Date): Promise<IShadowLog | null>`, only when unlabeled
  - `stats(since: Date): Promise<ShadowStats>`, with `ShadowStats = { byTier: Record<Tier, number>; wouldList: number; merges: number; labeled: number; sale: number; notSale: number }`
  - `lastRows(n: number): Promise<IShadowLog[]>`
- `memberRepository`: `touch(userId: string, now: Date): Promise<void>`, an upsert using `$setOnInsert: {firstSeenAt, askMode:"ask"}` only

- [ ] **Step 1: Write failing Mongo checks** in `checkMarket.ts`, using the SKIP pattern of `checkModerationClaim.ts` and a test-run id prefix for cleanup:
  - `indexes exist`: `syncIndexes()`, then assert the TTL seconds on `captures.lastAt` (604800) and `shadow_log.at` (10368000), and the partial unique index on `captures`.
  - `album then separate text joins one window`: three `appendMessage` calls at t=0, 1 s and 40 s (the first two share `mediaGroupId`, the third is text only) → one capture with 3 messageIds, 2 media and the text.
  - `new window after 90 s`: append at t=0, then append at t=95 s → the first capture is `closed` and a second is `open`.
  - `concurrent album items`: `Promise.all` of 5 appends with the same `mediaGroupId` at the same `now` → exactly one capture holding 5 messageIds.
  - `claimDue timing`: a capture with lastAt=t0 → `claimDue(t0+29 s)` is null, `claimDue(t0+30 s)` returns it, and a second `claimDue` is null.
  - `two sweeps claim once`: `Promise.all([claimClosed(), claimClosed()])` → exactly one is non-null.
  - `member touch keeps askMode`: set askMode `never` directly, `touch` again → still `never`.
- [ ] **Step 2: Run** `MONGO_URI=... pnpm run check-market`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the four models and four repositories with the signatures above. Types for the model shapes go in `src/types/index.ts` only where services need them, like the `Post` and `IPost` split.
- [ ] **Step 4: Run** `MONGO_URI=... pnpm run check-market && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: market collections and repositories`.

### Task 5: Reconcile `posts` → `bot` listings

**Files:**
- Create: `src/services/marketService.ts`
- Modify: `src/tests/checkMarket.ts`

**Interfaces:**
- Consumes: `listingRepository.findByPostId/createForPost/markSold`, and `postRepository` (add `findApprovedOrSold(): Promise<IPost[]>` to `postRepository.ts`).
- Produces: `export const LEGACY_CUTOFF = new Date("2026-11-04T00:00:00Z")`. Every prod post predates it (the newest is 2026-09-09), and a post made after it is new, so it gets a normal listing. Comment this. Also `reconcileBotListings(now: Date): Promise<{ created: number; sold: number }>`. For each approved or sold post with no listing: `createForPost(post, post.createdAt < LEGACY_CUTOFF ? "legacy" : "dm", hold = (post.status === "approved" && post.createdAt < LEGACY_CUTOFF), now)`. A sold post's listing is then marked sold. For each existing listing whose post is now `sold`, `markSold`. It is idempotent.

- [ ] **Step 1: Write failing checks:** `reconcile creates legacy hold`: an approved post dated before the cutoff → its listing is `origin:"legacy"`, `hold:true`, `live`. `reconcile new post not held`: a post after the cutoff → `origin:"dm"`, `hold:false`. `reconcile sold`: mark the post sold, reconcile again → the listing is `sold`. `reconcile idempotent`: a third run → `{created:0, sold:0}`, and there is still exactly one listing per post.
- [ ] **Step 2: Run** check-market. Expected: FAIL.
- [ ] **Step 3: Implement** `reconcileBotListings`.
- [ ] **Step 4: Run** check-market. Expected: PASS.
- [ ] **Step 5: Commit** `feat: reconcile bot listings from posts`.

### Task 6: Capture middleware

**Files:**
- Create: `src/services/captureService.ts`
- Modify: `src/controllers/botController.ts` (global message handler and an `edited_message` handler)
- Modify: `src/tests/checkRoutes.ts`

**Interfaces:**
- Consumes: `captureRepository.appendMessage/reparseOpen`, `memberRepository.touch`.
- Produces: `CaptureService` with `constructor(config: BotConfig)`, `isSaleTopicMessage(msg: Message): boolean` and `handleGroupMessage(msg: Message, now = new Date()): Promise<void>`, which never throws (it catches and logs `[ERROR - capture]`), plus `handleEdit(msg: Message): Promise<void>`.
- `isSaleTopicMessage` is true only when all of these hold: `msg.chat.id === config.approvedGroupId`; the topic matches (if `Number(config.approvedTopicId) === 1`, then `message_thread_id` is undefined or 1, otherwise `message_thread_id === approvedTopicId`); `from` is set and `!from.is_bot`; there's no `sender_chat`; it's not a forward (`forward_origin`); it's not a reply (`reply_to_message`, except the forum-topic root reply that Telegram adds in topics: ignore `reply_to_message.message_id === message_thread_id`); it's not a command (text starting with `/`); and it carries `text`, `caption`, `photo` or `video`.
- Wiring: in `registerRoutes`' global message handler, just before the final `return next()`, call `if (captureMode !== "off" && this.captureService.isSaleTopicMessage(msg)) await this.captureService.handleGroupMessage(msg)`, then continue to `next()` (capture never stops the chain). Register `bot.on("edited_message", …)` → `handleEdit` when it's a sale-topic message. Media: the largest `photo` size's `file_id`, or `video.file_id`.

- [ ] **Step 1: Write failing route checks** in `checkRoutes.ts` (set `config.captureMode = "shadow"` on the controller's config object in the test, and check the `captures` collection):
  - `topic 1 accepts missing thread id`: with `approvedTopicId` 1, a message in `approvedGroupId` without `message_thread_id` → one capture row.
  - `other topic ignored`: `message_thread_id` 48138 → no row.
  - `bot sender ignored`, `reply ignored`, `command ignored`, `other chat ignored` → no rows.
  - `capture is silent`: no API calls are recorded for any of the above (`expectSilence`).
  - `edit updates open capture`: a sale-topic message, then an `edited_message` with new text for the same message id → the open capture's text is the new text. An edit to a message that is in no open capture changes nothing and throws nothing.
- [ ] **Step 2: Run** check-routes. Expected: FAIL.
- [ ] **Step 3: Implement** `CaptureService` and the wiring. Extend the harness `message()` with optional `messageThreadId`, `isBot`, `mediaGroupId` and `caption` fields if needed (additive).
- [ ] **Step 4: Run** `MONGO_URI=... pnpm run check-routes && pnpm run check-flows`. Expected: PASS (existing flows unchanged).
- [ ] **Step 5: Commit** `feat: capture sale-topic messages into windows`.

### Task 7: Sweeper and shadow classification

**Files:**
- Create: `src/services/sweeper.ts`
- Create: `src/services/shadowService.ts`
- Create: `src/services/matchService.ts`
- Modify: `src/bot.ts` (lifecycle `init`/`close`)
- Modify: `src/tests/checkMarket.ts`

**Interfaces:**
- `sweeper.ts`: `startSweeper(jobs: Array<{ name: string; everyMs: number; run: () => Promise<void> }>): { stop(): void }`. Each job runs on its own `setInterval`. A run that throws is caught and logged as `[ERROR - sweeper:<name>]`, and a job never overlaps itself (it skips a tick while its previous run is still going). `stop()` clears every interval.
- `matchService.ts`: `rankMatches(query: string, listings: Pick<IListing,"_id"|"text"|"title"|"priceValue"|"refreshedAt">[], max = 5): string[]` is pure, following spec 7.1. A strong token is an alias-group term, or a 2+ character alphanumeric token containing a digit. A ceiling `עד NNN` filters on `priceValue`. Rank by overlap, then `refreshedAt` descending. It returns listing ids.
- `shadowService.ts`: `processOneClosed(config: BotConfig, now: Date): Promise<boolean>` returns false when nothing is claimed. It does: `claimClosed` → `classify(text, media.length>0)` → repost check (`findSellerRecent(senderId, now-30d)`, where a match is the same `textHash` or `tokenOverlap ≥ 0.8`, and the first hit is `mergeWith`) → `shadowLogRepository.insert({ chatId, messageIds, senderId, at: now, tier, rules, wouldList: tier==="strict" && !mergeWith, mergeWith, parsedTitle, parsedPrice, matches })`, where `matches` is computed only when `tier==="wtb"` and `buyerMatches==="shadow"` → `saveClassification`. Also `closeDueWindows(now: Date): Promise<number>` loops `claimDue` until it returns null, and `tick(config, now)` = `closeDueWindows` then `processOneClosed` until false.
- `bot.ts` lifecycle `init`: `await controller.reconcile()` (a thin wrapper that logs counts), then `sweeper = startSweeper([{ name:"captures", everyMs:10_000, run: () => tick(config, new Date()) }, { name:"reconcile", everyMs:3_600_000, run: () => reconcileBotListings(new Date()).then(()=>{}) }])`. `close`: `sweeper.stop()` before `disconnectDB()`. When `captureMode` is `off`, skip the captures job, but keep reconcile.

- [ ] **Step 1: Write failing checks:**
  - `window closes after restart`: append a capture at t0, drop every in-memory reference, call `tick(config, t0+31 s)` → one `shadow_log` row and the capture `classified`.
  - `strict row`: a fixture strict text with media → the row has `tier:"strict", wouldList:true`.
  - `repost merges`: a seller's bot listing with the same text → `mergeWith` = that listing id, `wouldList:false`.
  - `wtb logs matches`: a live non-hold listing with "גלוק 17" → a WTB capture "מחפש glock 17" logs `matches` containing it. A `hold:true` listing is never matched.
  - `no member text in shadow_log`: the inserted document's keys are a subset of the IShadowLog fields above (no `text`).
  - `failing job does not stop the scheduler`: a job that throws once, then counts. After about 2.5 intervals at `everyMs: 50`, the count is ≥ 1, and `stop()` halts it.
  - `rankMatches` pure cases: alias match, ceiling filter (`עד 800` excludes priceValue 900), at most 5 results, and no match on stop words only.
- [ ] **Step 2: Run** check-market. Expected: FAIL.
- [ ] **Step 3: Implement** `sweeper.ts`, `matchService.ts`, `shadowService.ts` and the `bot.ts` wiring. Add `// ponytail: single-process scheduler; atomic claims hold under replicas, move jobs to a leader/queue if we ever run more than one`.
- [ ] **Step 4: Run** `MONGO_URI=... pnpm test`. Expected: every check passes, with no [SKIP].
- [ ] **Step 5: Commit** `feat: sweeper, shadow classification and WTB match logging`.

### Task 8: `/label` (ADMIN) and `/stats` (MOD)

**Files:**
- Create: `src/services/shadowAdminService.ts`
- Modify: `src/controllers/callbackRoutes.ts`, `src/controllers/botController.ts`, `src/services/richMessages.ts` (help lines), and `src/locales/{en,he,ru}/common.json`
- Modify: `src/tests/checkCallbackData.ts`, `src/tests/checkRoutes.ts`

**Interfaces:**
- Callback `lb_<shadowLogId>_<s|n|k>` → action `"label"`, arg `"<id>_<s|n|k>"`. Golden rows: `lb_65f1c2a9e4b0c3d2a1f09876_s`, `..._n`, `..._k`.
- `ShadowAdminService(api, config)`:
  - `handleLabel(msg)`: DM only, ADMIN. It sends the next row: a link `https://t.me/<groupUsername>/<messageIds[0]>` (the username from `api.getChat({chat_id: approvedGroupId})`, cached for the process; if there is none, `https://t.me/c/<abs(id) without the -100 prefix>/<messageId>`), then `parsedTitle · parsedPrice`, then the buttons ✅ / ❌ / ⏭. With no rows left, it sends `labelEmpty`.
  - `handleLabelCallback(query, arg)`: ADMIN. `s`/`n` → `setLabel`; `k` → skip. Then it edits the message to the next row, or to `labelEmpty`.
  - `handleStats(msg)`: DM only, MOD and up. It sends one plain-text message with two columns (7 days, 30 days): sale posts (strict+ask), wtb, wouldList, reposts merged %, listings by status, legacy on hold, labeled n and precision = sale/(sale+notSale) (or `—` when n=0), and the hybrid gate line `n ≥ 100 and precision ≥ 97%: yes/no`.
- New locale keys (in all three languages): `labelEmpty`, `labelSale`, `labelNotSale`, `labelSkip`, `statsTitle`, `statsBody` (with params), `helpLabel`, `helpStats`. The `/help` admin section lists `/label`; the MOD-visible section lists `/stats` (follow `buildHelpMessage`'s existing level split).
- Register `cmd("label", …)` and `cmd("stats", …)` using `userService.hasAuthLevel` like `/pending`, with denial text `notAdmin`.

- [ ] **Step 1: Write failing tests:** the golden rows in `checkCallbackData.ts`. In `checkRoutes.ts`: `/stats` from a MOD user → one sendMessage containing the 7-day header; `/stats` from a USER → `notAdmin`; `/label` from a MOD (not ADMIN) → `notAdmin`; `/label` from an ADMIN with one seeded unlabeled row → a message whose text contains `t.me/` and a keyboard with 3 `lb_` buttons; pressing `lb_<id>_s` → the row is labeled `sale`.
- [ ] **Step 2: Run** `pnpm run check-callbacks` and check-routes. Expected: FAIL.
- [ ] **Step 3: Implement** the service, routes, help lines and locale keys.
- [ ] **Step 4: Run** `pnpm run check-locals && pnpm run check-callbacks && MONGO_URI=... pnpm run check-routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: /label and /stats for the shadow classifier`.

### Task 9: `/test` cases, synthetic run, docs, release prep

**Files:**
- Modify: `src/tests/testCases.ts`
- Create: `src/tests/syntheticCapture.ts` (run manually, not part of `pnpm test`)
- Modify: `docs/README.md` (Features, Commands), `docs/CHANGELOG.md`, `Agents.md` (Repository Structure: new models, repositories, services and checks; Commands table; Session Management: new collections), `package.json` version left alone (the release is cut with slice 1, as 3.0.0)

**Interfaces:**
- `/test` cases: `classify_fixtures`, labelled "🧪 Classify fixtures", DMs the tester a line per fixture (`tier · title · price`) from a small inline list. It can't wait for typed input; that is the `/test` convention. `shadow_last5`, labelled "🕵️ Shadow: last 5 rows", DMs the last 5 `shadow_log` rows (tier, wouldList, mergeWith, link).
- `syntheticCapture.ts`: refuses to run unless `BOT_TOKEN` starts with `9299714864:` (the test bot). It builds a `Bot` with the real token, a `BotController`, and `registerRoutes`, sets `captureMode:"shadow"`, then feeds `bot.handleUpdate` 20 hand-written fixture messages "from" user 278683632 in chat `-1002445943058`, topic 73. It runs `tick()` with the clock 2 minutes ahead, prints each resulting `shadow_log` tier next to the expected tier, and exits non-zero on a mismatch or if any `send*` call to the group was made. Use the harness pattern of wrapping `fetch` so only `getMe`/`getChat` reach Telegram and every other method fails the run.

- [ ] **Step 1: Add the two `/test` cases** and run `pnpm run build`. Expected: compiles.
- [ ] **Step 2: Write `syntheticCapture.ts`**, then run it against a throwaway Mongo with the local `.env` test token: `MONGO_URI=... pnpm exec ts-node src/tests/syntheticCapture.ts`. Expected: 20/20 tiers match, and zero group sends. Before running, check the token prefix without printing the token.
- [ ] **Step 3: Update docs:** README (features: shadow classifier, `/label`, `/stats`; commands table), CHANGELOG (an "Unreleased" entry in the file's format), and Agents.md (structure, commands table, the new collections are additive and the 2.0.1 rollback still works, the new check scripts in the testing table).
- [ ] **Step 4: Full verification:** `pnpm run lint && pnpm run build && MONGO_URI=... pnpm test`. Expected: exit 0, "Tests passed", no [SKIP].
- [ ] **Step 5: Commit, push, open the PR** to master. The PR body covers: scope, the review focus results, test output, `LEGACY_CUTOFF` to confirm at deploy, and a note that `captureMode: shadow` sends nothing. Don't merge.
