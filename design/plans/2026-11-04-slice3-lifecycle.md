# Slice 3: Listings That End + the Stale Sellers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "for sale" mean something. A listing is nudged once at day 7, expires at day 30 unless refreshed, and can be refreshed, sold, relisted or (group listings only) removed. New group cards carry a trust line. An admin command, `/stalecheck`, sends the one-time "still for sale?" DM to the sellers of the 28 legacy `hold` listings.

**Architecture:** `lifecycleService` owns every state change of a live listing (refresh, sold, remove, nudge, expire) behind functions that take an explicit `now`, so tests drive a fake clock. Repositories hold the atomic claims (`claimNudge`, `claimStale`). Two sweeper jobs (10 min lifecycle, 10 s held-nudge release) are added to the slice 0 sweeper. Today's `sold_`/`bump_` buttons keep working and now also move the listing. `staleCheckService` is the `/stalecheck` job. New callbacks: `lc_` (one listing action) and `sc_` (the `/stalecheck` confirm).

**Tech Stack:** TypeScript, node-telegram-bot-api 2.3.0 (v2 middleware chain), mongoose 9, Node stdlib `Intl`. No new dependencies.

**Spec:** `design/specs/2026-11-04-market-design.md` (sections 5.2-5.4, 6.7, 8.3, 11.1-11.4, 13 "Slice 3", 15). Read it, then the slice 0 plan (`2026-11-04-slice0-market-core.md`), before Task 1.

## Global Constraints

- Branch `feat/slice3-lifecycle` from the slice 2 branch (expected `feat/slice2-optin-capture`; use whatever name the slice 2 plan gives). One PR; don't merge without the owner.
- **Before Task 1, read `2026-11-04-slice1-moderation.md` and `2026-11-04-slice2-optin-capture.md`** (they were planned in parallel and may differ from the assumptions below), and write the answers to this list into the PR description:
  1. Slice 2's note sender (an ephemeral message to a member) and its name and signature. This plan calls it `NoteSender = (receiverUserId: number, text: string, keyboard: InlineKeyboardButton[][]) => Promise<boolean>` and injects it (Task 4). Wrap the real one in an adapter if the signature differs.
  2. Whether slice 2 already wrote Sold / Refresh / Remove handlers for `group` listings (its `ls_` callbacks). If so, make those handlers call `lifecycleService` (Task 2) and delete the duplicated logic. There must be one implementation of each state change. This plan uses its own `lc_` prefix because the `ls_` payload format is not known here (Task 5).
  3. Any `listingRepository` method that slices 1 or 2 added for ending a listing (take-down, remove) or refreshing it (the repost merge). Reuse it instead of adding `endListing`/`refresh` from Task 1, and route every `refreshedAt` write through one `refresh`.
  4. The approval-publish call sites after slice 1 (`grep -rn "showCta: true" src`) and slice 2's `/myposts` renderer and `l_` listing card (Task 6 and 7 wire into them).
- Follow `Agents.md`: services hold logic, repositories hold every Mongoose query, types in `src/types/index.ts`, no `any`, `[ERROR - <context>]` logs, params-object API calls, all text from locale files in `en`, `he` and `ru`.
- Additive data only: new optional fields on `listings` (`nudgeHeld`, `staleSentAt`), one optional `UserSession` field, no change to `posts`/`users`. The 2.0.1 image must still run against the database.
- Constants in code, not config: nudge after 7 days, expire after 30, stale answer window 7, nudge batch 25 per tick, held-nudge release delay 2 minutes, "new seller" 30 days. The only switch is the existing `nudges` (default `false`); expiry runs regardless of it.
- Nothing is sent to any member unless `nudges` is on (day-7 nudges) or the admin confirms `/stalecheck`. Slice 3 deploys with `nudges: false`, and the 28 legacy listings stay on `hold`.
- Sellers never remove approved bot posts: no `bot` listing offers Remove, and a forged `lc_x_` for one is refused.
- A bot post's group message is never touched except by today's Sold re-render and bump re-post.
- User-facing text is plain and short; the owner rewrites it. The `/stalecheck` DM text is a draft in the locale files only, and the owner replaces it after the dry run. No Hebrew string may contain `נשק` (`check-locals` enforces this).
- Pilot user ids are private. Tests use made-up ids (`100001` and up). The only real id allowed is the owner's `278683632` in the synthetic script (spec 13), because it is in the design doc.
- Callback formats are frozen once shipped. Pin `lc_` and `sc_` in `src/tests/checkCallbackData.ts`, each ≤ 64 bytes.
- Tests never use the production token or database. Mongo-gated checks run against a throwaway `mongo:8.2` (`docker run -d --rm --name s3-mongo -p 127.0.0.1:27031:27017 mongo:8.2`, `MONGO_URI=mongodb://127.0.0.1:27031/SalesBotTestDB`). A run that prints `[SKIP]` is not a pass.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the executing model's line).

## Decisions made in this plan (spec gaps and conflicts)

1. **Own callback prefix `lc_`.** `lc_<r|s|x>_<listingId>`: `r` still for sale / refresh / relist, `s` sold, `x` remove (group only). One handler serves the nudge DM, the held note, the `/stalecheck` DM and the `/myposts` Relist button. Slice 2's `ls_` handlers, if they exist, call the same service.
2. **DM first, 403 means "group-only".** `users` rows exist for anyone who ever pressed a button (including a note), so a `users` row does not mean "can be DMed". The nudge tries the DM and falls back to the held note on a 403. Same code for both sources.
3. **A held nudge is sent by a 10 s sweeper job, not on the message itself, and 2 minutes after the seller's message.** Their capture window (up to 90 s) must close and any repost merge (which refreshes the listing and cancels the nudge) must run first. It needs captures, so with `captureMode: off` held nudges are never released and the listing just expires.
4. **Refresh lifts `hold`.** A held legacy listing whose seller bumps it or reposts it has proven it is alive. It enters the normal lifecycle and is no longer eligible for `/stalecheck`.
5. **`/stalecheck` unanswered expiry uses its own field `staleSentAt`,** not `nudgedAt` alone. Otherwise a seller who answered ✅ and was later nudged normally at day 7 would be expired at day 14 by the "7 days" rule. `nudgedAt` is still set at send time, as the spec says. The send-once guard is `hold` (lifted at send, never set again).
6. **✅ on an `expired` listing relists it.** The intent is unambiguous and Relist exists anyway. 🤝 on an expired listing sells it. Any press on `sold`/`removed`/`taken_down` answers "no longer in the market".
7. **Trust line: hidden when n = 0 and the seller has been in the market under 30 days; shown otherwise.** The spec says "new seller" without defining it; 30 days is the constant `NEW_SELLER_DAYS`. Shown on new publishes (approval, bump re-post), the `/myposts` card and the `l_` card. Not on the Sold re-render or the moderation card.
8. **A bot listing whose post was sold under a rolled-back 2.0.1 is not nudged.** The nudge checks the post is still `approved` first and marks the listing sold if not (the hourly reconcile would do it later).
9. **Nudges are capped at 25 per tick,** so turning `nudges` on after listings have aged does not DM everyone in one burst. Expiry runs before nudging, and nothing older than 30 days is nudged.
10. **`/stalecheck` confirm state lives in the v2 session** (`UserSession.pendingStalecheck`), not memory. The seller list is snapshotted at the dry run and re-checked by the per-listing claim at confirm time.

## Review Focus

1. **A seller answers a stale or nudge DM after the listing expired, was sold elsewhere, or ended.** ✅ relists, 🤝 sells, other ended states show "no longer in the market" and drop the keyboard; nobody gets a stack trace or a double sale. Tests: Task 5 `answer after expiry`, `answer on ended listing`, Task 8 `✅ after expiry relists`.
2. **Sold on a bot post whose group message was deleted.** `markSoldInGroup` returns false; the post and the listing must still become `sold` and the seller still gets the confirmation. Test: Task 2 `sold with deleted group message`.
3. **A listing refreshed (repost merge, bump, ✅) while its nudge is held or already sent.** A held nudge must never be released for a refreshed listing, and a refresh must restart the 7-day clock with a fresh nudge possible. Tests: Task 4 `held nudge cancelled by refresh`, `refresh restarts the clock`.
4. **The bot is down for a day, or `nudges` is switched on late.** One tick can see nudge and expiry due at once (expire wins, no nudge for a listing past day 30), and 100 aged listings must not produce 100 DMs. Tests: Task 4 `catch-up tick`, `nudge batch cap`.
5. **`/stalecheck` pressed twice, or a seller's DM failing halfway.** One DM per seller; a repeat or a concurrent run sends nothing to a seller already contacted; a 403 expires at once; a transient error puts the listings back on hold so a re-run retries. Tests: Task 8 `concurrent runs`, `403 expires`, `transient failure restores hold`.

---

### Task 1: Lifecycle fields and repository operations

**Files:**
- Modify: `src/models/Listing.ts` (two optional fields and an index)
- Modify: `src/repositories/listingRepository.ts`
- Modify: `src/repositories/postRepository.ts`, `src/repositories/captureRepository.ts`, `src/repositories/memberRepository.ts`
- Modify: `src/models/User.ts` (type only: `createdAt?: Date` on `IUser`; the schema already has `timestamps: true`)
- Modify: `src/tests/checkMarket.ts`

**Interfaces:**
- Consumes (slice 0): `IListing` (`status`, `hold`, `source`, `origin`, `postId`, `sellerId`, `refreshedAt`, `nudgedAt`, `endedAt`, `endedBy`, `text`, `media`, `title`), `listingRepository.createForPost/markSold/findSellerRecent`.
- Produces: `IListing.nudgeHeld?: boolean` (a nudge was claimed but not delivered; waits for the seller's next group message) and `IListing.staleSentAt?: Date` (set by `/stalecheck`; starts the 7-day answer window). Index `{ nudgeHeld: 1 }` sparse.
- Produces, on `listingRepository` (every method that depends on time takes `now`; none calls `new Date()`):
  - `findById(id: string): Promise<IListing | null>`
  - `refresh(id: string, now: Date): Promise<IListing | null>`: matches `status` in `live`/`expired`; sets `status:"live"`, `refreshedAt = now`, `hold = false`; unsets `nudgedAt`, `nudgeHeld`, `staleSentAt`, `endedAt`, `endedBy`. Returns the updated listing, or null when the listing is in a final state.
  - `findNudgeCandidates(now: Date, limit: number): Promise<IListing[]>` and `claimNudge(id: string, now: Date): Promise<IListing | null>`: both require `status:"live"`, `hold` false, no `nudgedAt`, `refreshedAt <= now - 7 days` and `refreshedAt > now - 30 days`. `claimNudge` sets `nudgedAt = now` atomically.
  - `releaseNudgeClaim(id: string): Promise<void>` (unsets `nudgedAt` and `nudgeHeld`), `holdNudge(id: string): Promise<void>` (sets `nudgeHeld: true`).
  - `findHeldNudges(): Promise<IListing[]>` and `claimHeldRelease(id: string): Promise<IListing | null>` (`nudgeHeld` true and `status:"live"` → false, atomically).
  - `expireDue(now: Date): Promise<IListing[]>`: `live`, `hold` false, `refreshedAt <= now - 30 days` → `expired`, `endedAt = now`, `endedBy:"system"`. Returns the expired rows.
  - `expireStaleUnanswered(now: Date): Promise<IListing[]>`: `live`, `staleSentAt <= now - 7 days` → `expired`, same end fields.
  - `endListing(id: string, status: "sold" | "expired" | "removed", by: "seller" | "moderator" | "system", now: Date, scrub: boolean): Promise<IListing | null>`: only from `live`/`expired`; `scrub` unsets `text`, `media`, `title`. (Skip if slice 1/2 already added an equivalent.)
  - `countSold(sellerId: string): Promise<number>`; `findSellerExpired(sellerId: string, limit: number): Promise<IListing[]>`
  - `findStaleEligible(sellerIds: string[] | null): Promise<IListing[]>`: `origin:"legacy"`, `hold:true`, `status:"live"`, no `nudgedAt`, and `sellerId` in the list when given.
  - `claimStale(id: string, now: Date): Promise<IListing | null>`: the same filter plus `_id`; sets `hold:false`, `nudgedAt = staleSentAt = refreshedAt = now`.
  - `unclaimStale(id: string): Promise<void>`: back to `hold:true`, unsets `nudgedAt`, `staleSentAt`.
  - `setClockForTest(id: string, refreshedAt: Date): Promise<void>`: for `/test` cases only (comment it).
- Produces: `postRepository.findByIds(ids: string[]): Promise<IPost[]>` and `postRepository.firstCreatedAt(userId: string): Promise<Date | null>`; `memberRepository.findByUserId(userId: string): Promise<IMember | null>`; `captureRepository.hasSettledSince(chatId: number, senderId: string, since: Date, settledBefore: Date): Promise<boolean>`, which is true when the sender has a capture in a state other than `open` with `lastAt > since` and `lastAt <= settledBefore`.

- [ ] **Step 1: Write failing checks** in `checkMarket.ts` (fake clock: `T0 = new Date("2026-12-01T10:00:00Z")`, `d(n)` = n days in ms; each test seeds its own listings with a run-id title prefix):
  - `claimNudge at day 7 exactly once`: refreshedAt T0 → `claimNudge(id, T0+7d-1ms)` is null; `claimNudge(id, T0+7d)` is non-null with `nudgedAt = T0+7d`; a second call is null.
  - `nudge candidates filter`: five listings (hold, already nudged, sold, 31 days old, eligible 8 days old) → `findNudgeCandidates(T0+31d..., 10)` returns only the eligible one. (Seed so that the eligible one is exactly the 8-day-old at `now`.)
  - `refresh clears everything`: a listing with `nudgedAt`, `nudgeHeld`, `staleSentAt`, `hold:true` → after `refresh` all unset, `hold:false`, `refreshedAt = now`; an `expired` listing → `live`; a `sold` listing → null and unchanged.
  - `expireDue at day 30`: `expireDue(T0+30d-1ms)` → `[]`; `expireDue(T0+30d)` → that listing, now `expired`, `endedBy:"system"`, `endedAt = T0+30d`; a `hold:true` listing and a `sold` listing of the same age are untouched.
  - `expireStaleUnanswered at day 7`: `staleSentAt = T0` → nothing at `T0+7d-1ms`, expired at `T0+7d`; a listing with `nudgedAt` but no `staleSentAt` is untouched.
  - `claimStale once`: two concurrent `claimStale` on one id → exactly one non-null; the row has `hold:false`, `nudgedAt = staleSentAt = refreshedAt = now`; `unclaimStale` restores `hold:true` and unsets both.
  - `claimHeldRelease once`: `holdNudge` then `Promise.all` of two releases → exactly one non-null.
  - `endListing scrub`: `endListing(id,"removed","seller",now,true)` → `text`, `title`, `media` unset, `endedBy:"seller"`; from `sold` → null.
  - `hasSettledSince`: a closed capture at `lastAt = T0+1h` → true for `since=T0`, `settledBefore=T0+2h`; false for `settledBefore=T0+30min`; an `open` capture → false.
- [ ] **Step 2: Run** `MONGO_URI=... pnpm run check-market`. Expected: FAIL.
- [ ] **Step 3: Implement** the model fields and repository methods. Every filter lives in the query (atomic `findOneAndUpdate`); never read-then-write.
- [ ] **Step 4: Run** `MONGO_URI=... pnpm run check-market && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lifecycle): listing clock fields and atomic claims`.

### Task 2: `lifecycleService` core: refresh, sold, remove

**Files:**
- Create: `src/services/lifecycleService.ts`
- Modify: `src/services/postService.ts` (extract `markPostSold`)
- Modify: `src/services/myPostsService.ts` (`handleSoldCallback` uses `markPostSold`; behavior unchanged)
- Create: `src/tests/lifecycleFakes.ts` (a recording fake `Api` whose `sendMessage` can be told to reject with a real `TelegramApiError` 403, or a plain `Error`, per chat id; seed helpers; `T0`; `d()`; shared by Tasks 2, 4 and 8)
- Modify: `src/tests/checkMarket.ts`

**Interfaces:**
- Consumes: Task 1 repository methods, `postRepository.findById/updateStatus`, `userRepository.findByUserId`, `marketService.reconcileBotListings`.
- Produces in `postService.ts`: `markPostSold(post: Post): Promise<{ richMessage: InputRichMessage; groupEdited: boolean }>`. It sets the post `sold`, builds the sold rich message exactly as `handleSoldCallback` does today, and calls `markSoldInGroup` when `approvedMessageId` is set. A failed group edit returns `groupEdited:false` and never throws.
- Produces in `lifecycleService.ts`:
  - Constants: `NUDGE_AFTER_DAYS = 7`, `EXPIRE_AFTER_DAYS = 30`, `STALE_ANSWER_DAYS = 7`, `NUDGE_BATCH = 25`, `HELD_RELEASE_DELAY_MS = 120_000`, `NEW_SELLER_DAYS = 30`.
  - `type LifecycleOutcome = "ok" | "ended" | "forbidden" | "not_found" | "not_allowed"` and `interface LifecycleResult { outcome: LifecycleOutcome; listing?: IListing; groupEdited?: boolean }`.
  - `type NoteSender = (receiverUserId: number, text: string, keyboard: InlineKeyboardButton[][]) => Promise<boolean>`.
  - `class LifecycleService { constructor(api: Api, config: BotConfig, postService: PostService, deps: { sendNote: NoteSender; botUsername: () => string }) }` with:
    - `refreshListing(listingId: string, actorId: string, now: Date): Promise<LifecycleResult>`: seller only; `live` → refresh, `expired` → relist (same call), final states → `ended`.
    - `sellListing(listingId: string, actorId: string, now: Date): Promise<LifecycleResult>`: seller only. A `bot` listing: `postService.markPostSold(post)` first, then `endListing(...,"sold","seller")`. A `group` listing: market only. An already-ended listing → `ended` with no side effects.
    - `removeListing(listingId: string, actorId: string, now: Date): Promise<LifecycleResult>`: `group` source only (`bot` → `not_allowed`); `endListing(...,"removed","seller",now,true)`; never touches the member's group message.
    - `ensureBotListing(postId: string, now: Date): Promise<IListing | null>`: the listing for an approved/sold post, created like the reconcile does when the hourly job has not run yet. Reuses `createForPost`; a duplicate-key race returns the existing row.
    - `syncSoldForPost(postId: string, now: Date): Promise<void>` and `refreshForPost(postId: string, now: Date): Promise<void>`: used by the existing `sold_`/`bump_` handlers; both go through `ensureBotListing`.

- [ ] **Step 1: Write failing checks** (`checkMarket.ts`, with `lifecycleFakes.ts`; a stub `PostService` records `markPostSold` calls and can be set to return `groupEdited:false`):
  - `sold bot listing sets post sold`: approved post + live `bot` listing → `sellListing` → `{outcome:"ok"}`; post `sold`; listing `sold`, `endedBy:"seller"`; `markPostSold` called once.
  - `sold group listing leaves posts alone`: `group` listing → `ok`, `markPostSold` never called, no `posts` row touched.
  - `sold twice is ended`: second call → `{outcome:"ended"}` and `markPostSold` still called once.
  - `sold by another user`: `{outcome:"forbidden"}`, listing still `live`.
  - `sold with deleted group message`: `markPostSold` returns `groupEdited:false` → `{outcome:"ok", groupEdited:false}`; post and listing both `sold`.
  - `remove bot listing refused`: `{outcome:"not_allowed"}`, listing still `live`, `text` intact.
  - `remove group listing scrubs`: `ok`, status `removed`, `endedBy:"seller"`, `text`/`title`/`media` unset.
  - `refresh restarts the clock`: live listing at T0 with `nudgedAt` → `refreshListing` at T0+8d → `refreshedAt = T0+8d`, `nudgedAt` unset.
  - `refresh relists expired`: `expired` → `live`; `sold` → `ended`.
  - `ensureBotListing creates and is idempotent`: approved post with no listing → one listing; two concurrent calls → still one row.
  - `reconcile after a simulated 2.0.1 sell`: approved post + live listing; set the post `sold` directly (what 2.0.1 does); `reconcileBotListings(now)` → listing `sold`, result `{created:0, sold:1}`.
  - Regression: `pnpm run check-flows` check (l) (the `/myposts` sold card) still passes after the extraction.
- [ ] **Step 2: Run** check-market. Expected: FAIL.
- [ ] **Step 3: Implement** `markPostSold` by moving the body of `handleSoldCallback` (post status, user lookup, sold rich message, group edit); `handleSoldCallback` then calls it and keeps editing the pressed card. Implement the service. Log `[ERROR - lifecycle.<method>]`.
- [ ] **Step 4: Run** `MONGO_URI=... pnpm run check-market && pnpm run check-flows && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lifecycle): refresh, sold and remove for listings`.

### Task 3: Today's `sold_` and `bump_` keep the listing in step

**Files:**
- Modify: `src/services/myPostsService.ts` (constructor gets `lifecycleService`), `src/controllers/botController.ts` (construct `LifecycleService`)
- Modify: `src/tests/checkFlows.ts` (add to the (l) block)

**Interfaces:**
- Consumes: `lifecycleService.syncSoldForPost/refreshForPost`.
- Produces: `MyPostsService` constructor `(api, config, postService, lifecycleService)`. After a successful `sold_`, call `syncSoldForPost(postId, new Date())`. After a successful bump (limit not hit), call `refreshForPost(postId, new Date())`. Errors in the listing step are logged and never fail the button.
- `BotController` builds `LifecycleService(api, config, postService, { sendNote, botUsername })`. `sendNote` is the slice 2 adapter (see Global Constraints item 1). `botUsername` is read from `registerRoutes`' argument (store it on the controller before first use).

- [ ] **Step 1: Write failing checks** in `checkFlows.ts` (block (l) already seeds approved posts and presses `sold_`/`bump_`): after `sold_<id>` the post's listing is `sold` (created on demand); after `bump_<id>` its listing has `refreshedAt` within 5 s of now and no `nudgedAt` (seed one with `nudgedAt` set); a bump refused by `dailyBumpLimit` leaves `refreshedAt` unchanged; bumping an `expired` listing makes it `live`.
- [ ] **Step 2: Run** `MONGO_URI=... pnpm run check-flows`. Expected: FAIL on the new assertions only.
- [ ] **Step 3: Implement** the two calls and the controller wiring.
- [ ] **Step 4: Run** `MONGO_URI=... pnpm run check-flows && pnpm run check-routes && pnpm run build`. Expected: PASS, existing assertions unchanged.
- [ ] **Step 5: Commit** `feat(lifecycle): sold and bump move the listing`.

### Task 4: Nudge, expiry and held-nudge release (the sweeper jobs)

**Files:**
- Modify: `src/services/lifecycleService.ts`
- Modify: `src/controllers/botController.ts` (`lifecycleJobs()`), `src/bot.ts` (add the jobs to `startSweeper`)
- Modify: `src/locales/{en,he,ru}/common.json`
- Modify: `src/tests/checkMarket.ts`

**Interfaces:**
- Consumes: Task 1 and 2, slice 0 `startSweeper`, `captureRepository.hasSettledSince`, `postRepository.findById`, `localeService`, `isApiError` (a 403 is `isApiError(err, 403, "")`).
- Produces on `LifecycleService`:
  - `tick(now: Date): Promise<{ expired: number; staleExpired: number; nudged: number; held: number }>`: in this order: `expireDue`, `expireStaleUnanswered`, then, only if `config.nudges === true`, up to `NUDGE_BATCH` listings from `findNudgeCandidates` through `nudgeOne`.
  - `nudgeOne(listing: IListing, now: Date): Promise<"sent" | "held" | "skipped" | "retry">`: `claimNudge` first (null → `skipped`). For a `bot` listing, load the post; if it is not `approved`, `endListing(...,"sold","system")` when sold and return `skipped`. Then `api.sendMessage` the DM card to `sellerId` (plain text, `nudgeAsk` with `{title}` `{price}`, seller's locale): row 1 `[nudgeStillButton → lc_r_<id>] [nudgeSoldButton → lc_s_<id>]`, row 2 `[nudgeRemoveButton → lc_x_<id>]` for `group` only. A 403 → `holdNudge(id)` and `held`. Any other error → `releaseNudgeClaim(id)` and `retry` (logged), so the next tick tries again.
  - `releaseHeldNudges(now: Date): Promise<number>`: no-op unless `config.nudges === true`. For each `findHeldNudges()` row where `captureRepository.hasSettledSince(chatId = config.approvedGroupId, sellerId, nudgedAt, now - HELD_RELEASE_DELAY_MS)` is true: `claimHeldRelease` then `deps.sendNote(Number(sellerId), text, keyboard)`. The keyboard is the nudge keyboard plus a URL button `[nudgeManageButton → https://t.me/<bot>?start=l_<id>]`. A note that fails to send is logged and not retried (the listing expires on day 30).
  - `jobs(): Array<{ name: string; everyMs: number; run: () => Promise<void> }>`: `lifecycle` every 600_000 ms running `tick(new Date())`, and `held-nudges` every 10_000 ms running `releaseHeldNudges(new Date())`. Both stay registered when `captureMode` is `off`.
- New locale keys: `nudgeAsk` (`{title}` `{price}`), `nudgeStillButton`, `nudgeSoldButton`, `nudgeRemoveButton`, `nudgeManageButton`.

- [ ] **Step 1: Write failing checks** (`checkMarket.ts`; fake `Api` from `lifecycleFakes.ts`; `config.nudges = true` unless stated; sellers `"100001"`...):
  - `nudge at day 7 exactly once`: bot listing refreshed T0 → `tick(T0+7d-1ms)` sends 0; `tick(T0+7d)` sends 1 DM to the seller whose keyboard holds `lc_r_<id>` and `lc_s_<id>` and no `lc_x_`; `tick(T0+7d+10min)` sends nothing more.
  - `group nudge offers remove`: a `group` listing's DM keyboard also has `lc_x_<id>`.
  - `refresh restarts the clock`: nudged at day 7, `refreshListing` at day 8 → `tick(T0+14d)` sends nothing new; `tick(T0+15d)` sends the second DM.
  - `expiry at day 30 sends nothing`: after the day-7 nudge, `tick(T0+30d)` → status `expired`, DM count still 1, the `posts` row still `approved`.
  - `catch-up tick`: a never-nudged listing refreshed at T0 and a first tick at `T0+31d` → expired, 0 DMs.
  - `nudges false still expires`: `config.nudges = false`; `tick(T0+8d)` sends 0; `tick(T0+30d)` expires.
  - `hold is untouched`: a `hold:true` listing at `T0+60d` stays `live`, no DM.
  - `nudge skips a post sold by 2.0.1`: post set `sold` directly; `tick(T0+7d)` → no DM, listing `sold`, `endedBy:"system"`.
  - `nudge batch cap`: 30 due listings → first `tick` sends 25, the next tick the other 5.
  - `transient error retries`: the fake `sendMessage` throws a plain `Error` once → `nudgedAt` unset, the next tick sends the DM.
  - `concurrent ticks send once`: `Promise.all([tick, tick])` → one DM.
  - `403 holds the nudge`: fake `sendMessage` rejects with a `TelegramApiError` 403 for that seller → no DM, `nudgedAt` set, `nudgeHeld:true`.
  - `held nudge released after the next message`: with the held listing above and no capture → `releaseHeldNudges(T0+8d)` returns 0. Insert a closed capture for the seller with `lastAt = T0+8d` → `releaseHeldNudges(T0+8d+119s)` returns 0; at `+120s` it returns 1, the note text is `nudgeAsk` with the title, the keyboard has the `start=l_<id>` URL button, `nudgeHeld` is cleared; calling again returns 0.
  - `held nudge cancelled by refresh`: held, then `refresh(id, T0+8d)` (what the repost merge does) → `releaseHeldNudges` returns 0 and sends nothing.
  - `held nudge never released expires`: held at day 7, `tick(T0+30d)` → `expired`.
  - `held nudge off switch`: `config.nudges = false` → `releaseHeldNudges` returns 0.
- [ ] **Step 2: Run** check-market. Expected: FAIL.
- [ ] **Step 3: Implement** `tick`, `nudgeOne`, `releaseHeldNudges`, `jobs()`. Wire `controller.lifecycleJobs()` into the `startSweeper` list in `bot.ts`. Add `// ponytail: single-process scheduler, atomic claims make a second replica safe` next to the jobs. Add the locale keys.
- [ ] **Step 4: Run** `MONGO_URI=... pnpm run check-market && pnpm run check-locals && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lifecycle): day-7 nudge, day-30 expiry and held nudges`.

### Task 5: `lc_` callbacks (still for sale, sold, remove)

**Files:**
- Modify: `src/controllers/callbackRoutes.ts`, `src/controllers/botController.ts` (dispatch)
- Modify: `src/services/lifecycleService.ts` (`handleCallback`)
- Modify: `src/locales/{en,he,ru}/common.json`
- Modify: `src/tests/checkCallbackData.ts`, `src/tests/checkRoutes.ts`

**Interfaces:**
- Produces: `CallbackAction` gains `"lifecycle"`. `routeCallback("lc_r_<id>")` → `{ action: "lifecycle", arg: "r_<id>" }` (same for `s`, `x`). Golden rows (`ID = 65f1c2a9e4b0c3d2a1f09876`): `lc_r_${ID}`, `lc_s_${ID}`, `lc_x_${ID}` (29 bytes each). Negative rows: `lc_` → route with an empty arg is acceptable but `handleCallback` must ignore it (assert `routeCallback("lc_")` equals `{action:"lifecycle",arg:""}`); `lcx_` → null.
- Produces: `LifecycleService.handleCallback(query: CallbackQuery, arg: string, now = new Date()): Promise<void>`. Parses `/^([rsx])_([0-9a-f]{24})$/` (anything else → toast `staleButton`). Calls `refreshListing`/`sellListing`/`removeListing` with `String(query.from.id)`. Toasts (`answerCallbackQuery`, seller's locale): ok → `lcRefreshed` / `lcSold` / `lcRemoved` (each with `{title}`), `ended` → `lcEnded`, `forbidden` → `lcNotYours`, `not_allowed` → `lcNoRemove`, `not_found` → `lcEnded`. Then edit the pressed message: remove the keyboard rows that contain this listing's id (so a `/stalecheck` DM with two posts keeps the other post's row), and when the outcome is ok append the outcome line to the text. For `ended` and `not_found`, also drop that row. If `query.message` is missing (a private note), edit through slice 2's note-edit helper when one exists, otherwise only answer the toast. `message is not modified` is ignored (`isApiError`).
- New locale keys: `lcRefreshed`, `lcSold`, `lcRemoved`, `lcEnded`, `lcNotYours`, `lcNoRemove`.

- [ ] **Step 1: Write failing checks.** `checkCallbackData.ts`: the three golden rows plus the two negative rows. `checkRoutes.ts` (harness, Mongo, seeded listings): `seller refresh`: `lc_r_<id>` from the seller → one `answerCallbackQuery` with the `lcRefreshed` text, `refreshedAt` updated; `foreign press`: another user → `lcNotYours` toast, listing unchanged; `answer after expiry`: `lc_r_<id>` on an `expired` listing → `live` again; `lc_s_<id>` on an `expired` bot listing → listing and post `sold`; `answer on ended listing`: `lc_r_<id>` on a `removed` listing → `lcEnded` toast and an `editMessageReplyMarkup`/`editMessageText` that leaves no keyboard; `bot listing remove refused`: `lc_x_<id>` on a `bot` listing → `lcNoRemove`, listing still `live`; `group remove`: `lc_x_<id>` on a `group` listing → `removed`; `two-row DM keeps the other row`: a stale-style keyboard with two listings, press one → the edit's `reply_markup` still contains only the other listing's `lc_` buttons; `card never offers remove for bot`: the keyboards built for a `bot` listing in Task 4 (`nudgeKeyboard(listing, locale, botUsername)`, export it) contain no `lc_x_` button, and the one for a `group` listing does.
- [ ] **Step 2: Run** `pnpm run check-callbacks`, then `MONGO_URI=... pnpm run check-routes`. Expected: FAIL.
- [ ] **Step 3: Implement** the route, dispatch branch (`await this.lifecycleService.handleCallback(query, route.arg)`) and handler. If slice 2 has `ls_` handlers for the same actions, point them at `lifecycleService` here.
- [ ] **Step 4: Run** `pnpm run check-callbacks && pnpm run check-locals && MONGO_URI=... pnpm run check-routes && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lifecycle): lc_ callbacks for refresh, sold and remove`.

### Task 6: Trust line on new group cards (11.3)

**Files:**
- Create: `src/services/trustService.ts`
- Modify: `src/services/postService.ts` (`formatPostRichMessage` option), `src/services/moderationService.ts` and the slice 1 approval-publish path, `src/services/myPostsService.ts` (bump re-post, `/myposts` card), slice 2's `l_` card if present
- Modify: `src/locales/{en,he,ru}/common.json`
- Modify: `src/tests/checkRichMessages.ts`, `src/tests/checkMarket.ts`

**Interfaces:**
- Produces: `formatPostRichMessage(data, opts)` gains `opts.trustLine?: string`. When set, one extra list item `richListItem(b => b.paragraph(opts.trustLine))` follows the 👤 item. Without it the output is byte-identical to today.
- Produces in `trustService.ts`:
  - `formatSince(date: Date, locale: string): string`: `new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(date)`.
  - `marketSince(sellerId: string): Promise<Date | null>`: the earliest of `members.firstSeenAt`, `users.createdAt` and `postRepository.firstCreatedAt(sellerId)` that exist.
  - `trustLineFor(sellerId: string, locale: string, now: Date): Promise<string | null>`: `n = listingRepository.countSold(sellerId)`. Returns `null` when `n === 0` and (`since` is null or `now - since < NEW_SELLER_DAYS`); otherwise `localeService.t(locale, "trustLine", { n, since: formatSince(since, locale) })`.
- New locale key `trustLine`: en `🤝 {n} sales · in the market since {since}`, he `🤝 {n} מכירות · בשוק מאז {since}`, ru `🤝 {n} продаж · на рынке с {since}`.
- Wiring (what gets the line): every `formatPostRichMessage(..., { showCta: true })` publish (the approval publish, the instant trusted publish from slice 1, the bump re-post), the `/myposts` approved card, slice 2's `l_` card. Not the Sold re-render, the moderation card, or `syncSoldPosts`. Use `config.lang` for group publishes and the viewer's locale for DM cards. Slice 4 will call `trustLineFor` for alerts and buyer notes.

- [ ] **Step 1: Write failing checks.** `checkRichMessages.ts`: leave `goldenPost` and `checkPosts` untouched. Add `goldenPostWithTrust(config, data, opts, trustLine)`, which calls `goldenPost` and splices `{ blocks: [{ type: "paragraph", text: trustLine }] }` after the third item of the `list` block, and a new `checkPostsWithTrust()` over a small matrix (0/1/3 photos, `sold` false, `showCta` true, with and without username) asserting `assertSame(service.formatPostRichMessage(data, {...opts, trustLine}), goldenPostWithTrust(...))` for `trustLine = "🤝 3 sales · in the market since November 2026"`, plus the explicit assertion that `formatPostRichMessage(data, opts)` equals the old `goldenPost` result when `trustLine` is undefined. Register it in the script's case count. `checkMarket.ts`: `trust line hidden for a new seller`: n=0, `members.firstSeenAt = now-10d` → `null`; `trust line shown for a veteran with no sales`: n=0, since `now-90d` → `🤝 0 sales · in the market since <formatSince>`; `trust line counts sold across sources`: two `sold` listings (one `bot`, one `legacy`) and one `live` → n=2; `since is the earliest`: member `now-20d`, user `now-200d`, first post `now-100d` → `formatSince(now-200d)`; `formatSince(new Date("2026-11-15T00:00:00Z"), "en")` equals `"November 2026"`.
- [ ] **Step 2: Run** `pnpm run check-rich` and check-market. Expected: FAIL.
- [ ] **Step 3: Implement** the option, the service and the wiring at the call sites found with `grep -rn "showCta: true" src`.
- [ ] **Step 4: Run** `pnpm run check-rich && pnpm run check-locals && MONGO_URI=... pnpm run check-market && pnpm run check-flows && pnpm run build`. Expected: PASS, and the old post golden cases pass unchanged.
- [ ] **Step 5: Commit** `feat(lifecycle): trust line on new group cards`.

### Task 7: Relist from `/myposts`

**Files:**
- Modify: `src/services/myPostsService.ts` (or slice 2's `/myposts` renderer)
- Modify: `src/locales/{en,he,ru}/common.json`
- Modify: `src/tests/checkRoutes.ts`

**Interfaces:**
- Consumes: `listingRepository.findSellerExpired`, the `lc_r_` callback of Task 5.
- Produces: at the end of `showPosts`, when the seller has `expired` listings (up to 10, newest first), one extra message `endedSectionTitle` with one button row per listing, `[relistButton {title} → lc_r_<id>]`. If slice 2 already renders an ended section, add the buttons there instead and send no extra message. Relist is the same `lc_r_` call (it relists an `expired` listing and refreshes the clock). New keys: `endedSectionTitle`, `relistButton`.

- [ ] **Step 1: Write failing checks** (`checkRoutes.ts`): `/myposts` for a seller with one `expired` listing → a message containing `endedSectionTitle` and a button `lc_r_<id>`; for a seller with no expired listing → no such message; pressing the button → listing `live`, `refreshedAt` updated; a `sold` listing never gets a Relist button.
- [ ] **Step 2: Run** check-routes. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `MONGO_URI=... pnpm run check-routes && pnpm run check-locals && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lifecycle): relist expired listings from /myposts`.

### Task 8: `/stalecheck` (ADMIN, DM)

**Files:**
- Create: `src/services/staleCheckService.ts`
- Modify: `src/controllers/botController.ts` (command, `sc_` dispatch), `src/controllers/callbackRoutes.ts`, `src/types/index.ts` (`UserSession.pendingStalecheck?: { sellerIds: string[]; at: number }`)
- Modify: `src/services/richMessages.ts` (`helpStalecheck` in the admin help list), `src/locales/{en,he,ru}/common.json`
- Modify: `src/tests/checkCallbackData.ts`, `src/tests/checkMarket.ts`, `src/tests/checkRoutes.ts`, `src/tests/checkRichMessages.ts` (`goldenHelp`'s admin array gets `helpStalecheck` appended; this is the only edit to the help golden)

**Interfaces:**
- Consumes: `listingRepository.findStaleEligible/claimStale/unclaimStale/refresh/endListing`, `postRepository.findByIds`, `lifecycleService.sellListing`, `userRepository.findByUserId`.
- Produces in `staleCheckService.ts`:
  - `interface StalePlan { sellers: Array<{ sellerId: string; listings: IListing[] }>; unknownIds: string[] }`
  - `interface StaleReport { busy: boolean; sellersSent: number; listingsSent: number; blocked: number; failed: number }`
  - `parseSellerIds(args: string): { ids: string[]; invalid: string[] }`: whitespace split, each id must match `/^\d{3,15}$/`.
  - `renderStaleDm(input: { firstName: string; items: Array<{ listingId: string; title: string; price: string; postedAt: Date }>; locale: string }): { text: string; keyboard: InlineKeyboardButton[][] }`. Plain text (no parse mode). Intro, then `staleDmItem` lines numbered from 1 with the post date `D.M.YYYY` (UTC parts), then the outro. Keyboard: one row per post, `[staleStillButton {i} → lc_r_<id>] [staleSoldButton {i} → lc_s_<id>]`. No remove button, ever.
  - `class StaleCheckService { constructor(api: Api, config: BotConfig, lifecycle: LifecycleService) }` with `plan(sellerIds: string[] | null): Promise<StalePlan>` (groups `findStaleEligible` by seller; `unknownIds` are requested ids with no eligible listing) and `run(sellerIds: string[] | null, now: Date): Promise<StaleReport>`.
  - `run`: an in-process `running` flag; a second call while running returns `{busy:true, ...0}` (`// ponytail: single process, the per-listing claim is the real guard`). For each seller: claim every listing with `claimStale(id, now)`; load the posts; drop (and `endListing(...,"sold","system")` when the post is sold) any whose post is no longer `approved`; if nothing is left, continue. Send **one** DM with `renderStaleDm`. Success → counted. A 403 → `endListing(id,"expired","system",now,false)` for each claimed listing (`blocked++`). Any other error → `unclaimStale` for each (`failed++`), logged.
  - Expiry of unanswered DMs needs no code here: `tick` (Task 4) expires `staleSentAt <= now - 7 days`, and ✅ clears `staleSentAt` through `refresh`.
- Command `/stalecheck [userId …]` (`cmd("stalecheck", ...)`, DM only, `AuthLevel.ADMIN`, denial `notAdmin`). Invalid ids → `staleBadIds`, nothing else. Otherwise it runs `plan` and sends (1) `staleDryRun` with `{listings}`, `{sellers}`, `{scope}` (all, or the number of pilot ids) and the unmatched ids, and (2) the exact DM for the first seller rendered with `renderStaleDm` as text with the button labels appended as plain lines (no callback buttons on the preview), followed by the keyboard `[staleConfirmButton → sc_go] [staleCancelButton → sc_no]`. The seller ids from the plan are stored in `session.data.pendingStalecheck = { sellerIds, at: Date.now() }`. With nothing eligible: `staleNothing`, no keyboard, no session data.
- Callbacks: `routeCallback("sc_go")` → `{action:"stalecheck", arg:"go"}`, `"sc_no"` → arg `"no"`. Golden rows `sc_go`, `sc_no`. On `go`: ADMIN only; read and delete `pendingStalecheck` from the session (missing or older than 1 hour → `staleButton` toast, keyboard removed); `detach("/stalecheck", run(sellerIds, new Date()))` then send the admin `staleDone` with the report (or `staleBusy`). The send loop touches no session.
- New locale keys: `staleDmIntro`, `staleDmItem`, `staleDmOutro`, `staleStillButton`, `staleSoldButton`, `staleDryRun`, `staleConfirmButton`, `staleCancelButton`, `staleDone`, `staleBusy`, `staleBadIds`, `staleNothing`, `helpStalecheck`. Draft Hebrew for the DM (from spec 11.4; the owner replaces it): intro `שלום {firstName} 👋\nכאן הבוט של קבוצת המכירות. אנחנו מסדרים את השוק, ויש לך אצלנו מודעות שמסומנות כפעילות כבר יותר מחודש:`, item `{i}. {title} · {price} (מ־{date})`, outro `מה המצב? לחיצה אחת לכל מודעה.\nזו הודעה חד־פעמית. מודעה בלי תשובה תוסר מהשוק בעוד 7 ימים. ההודעה בקבוצה נשארת כמו שהיא.`, buttons `{i} ✅ עדיין למכירה` / `{i} 🤝 נמכר`. Plain translations for `en` and `ru`.

- [ ] **Step 1: Write failing checks.**
  `checkMarket.ts` (seed: sellers `"100001"` with two legacy `hold` listings, `"100002"` with one, `"100003"` with a normal non-hold listing; posts `approved` with known `createdAt`; fake `Api`):
  - `plan counts`: `plan(null)` → 2 sellers, 3 listings; `plan(["100001"])` → 1 seller, 2 listings; `plan(["999999"])` → `unknownIds:["999999"]`.
  - `parseSellerIds`: `"100001 100002"` → both; `"abc 12"` → `invalid:["abc","12"]`.
  - `render`: the text contains both titles, `1.` and `2.`, the date `D.M.YYYY` of the post, and the firstName; the keyboard has two rows, each `lc_r_<id>` + `lc_s_<id>`, and no `lc_x_`; with an empty firstName there is no double space.
  - `pilot sends only to listed`: `run(["100001"], T0)` → exactly one DM, to `100001`, containing both titles; both listings have `hold:false` and `nudgedAt = staleSentAt = refreshedAt = T0`; `100002`'s listing is still `hold:true`.
  - `second run does not resend`: `run(["100001"], T0+1h)` → 0 DMs; `run(null, T0+1h)` → one DM to `100002` only; a third `run(null, ...)` → 0 DMs.
  - `403 expires`: the fake rejects 403 for `100002` → its listing `expired`, `endedBy:"system"`, `blocked:1`.
  - `transient failure restores hold`: the fake throws a plain `Error` → listings back to `hold:true`, no `nudgedAt`, `failed:1`; a re-run sends the DM.
  - `concurrent runs`: `Promise.all([run(null,T0), run(null,T0)])` → one of them reports `busy:true`; total DMs = 2 (one per seller). Also `Promise.all` of two `claimStale` on one listing → one non-null (already in Task 1; assert here that no listing was sent twice).
  - `post sold by 2.0.1 is dropped`: one of a seller's posts set `sold` → the DM lists only the other; if both are sold, no DM and both listings `sold`.
  - `no answer in 7 days`: after the send at T0, `lifecycle.tick(T0+7d-1ms)` expires nothing, `tick(T0+7d)` expires the unanswered listing (`endedBy:"system"`); a listing answered with ✅ at T0+2d (via `refreshListing`) stays `live` at `T0+7d`, is **not** nudged at `T0+7d` (refreshed at day 2), and is nudged at `T0+9d`.
  - `✅ after expiry relists` and `🤝 after expiry sells`: after the expiry above, `refreshListing` → `live`; `sellListing` on another expired legacy listing → listing and post `sold`.
  `checkRoutes.ts`: `/stalecheck` from a USER and from a MOD → `notAdmin`, no data change; from an ADMIN with nothing eligible → `staleNothing`; with seeded listings → two messages, the second with `sc_go`/`sc_no`, and **no DM to any seller yet** and no listing changed; `/stalecheck 100001 x` → `staleBadIds`; pressing `sc_go` from a USER is refused; pressing `sc_go` as the ADMIN who ran the dry run → the seller DMs are sent (assert via `settle()`), `pendingStalecheck` is gone, a second press → `staleButton`; `sc_no` → keyboard removed, nothing sent.
  `checkCallbackData.ts`: `sc_go`, `sc_no` rows. `checkRichMessages.ts`: the help golden for ADMIN level includes `helpStalecheck`.
- [ ] **Step 2: Run** the three checks. Expected: FAIL.
- [ ] **Step 3: Implement** the service, command, callbacks, help line, session type and locale keys.
- [ ] **Step 4: Run** `pnpm run check-callbacks && pnpm run check-locals && pnpm run check-rich && MONGO_URI=... pnpm run check-market && MONGO_URI=... pnpm run check-routes && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lifecycle): /stalecheck for the legacy listings`.

### Task 9: `/test` cases, synthetic run, docs, release prep

**Files:**
- Modify: `src/tests/testCases.ts`
- Create: `src/tests/syntheticLifecycle.ts` (run manually, not part of `pnpm test`)
- Modify: `docs/README.md` (Features, Commands), `docs/CHANGELOG.md`, `Agents.md` (structure, Commands table, Post Lifecycle section, the rule that approved bot posts end only by Sold, expiry or take-down), `config.json.example` (no change expected: `nudges` exists from slice 0)

**Interfaces:**
- `/test` cases (labels exact):
  - `age_listing_7`, "⏩ Age my test listing 7 days": finds or creates the tester's test listing (a `[test] lifecycle` approved post with `approvedMessageId` null and a `bot` listing via `createForPost(post,"dm",false,now)`; find it again with `findSellerRecent(sellerId, new Date(0))` by title), calls `setClockForTest(id, now - 7 days)` (only when it is `live` and not nudged), then `new LifecycleService(api, config, postService, { sendNote: async () => false, botUsername }).tick(new Date())` so the nudge DM arrives at once. If `config.nudges` is false it replies "nudges is off: /config nudges true first" and changes nothing.
  - `age_listing_30`, "⏩ Age my test listing 30 days": the same with 30 days; replies with the resulting status (`expired`) and that no message was sent.
  - `stale_dry_run`, "📨 Stale-check dry run (to me only)": deletes the tester's previous `[test] stale` posts and listings, seeds two approved posts with `origin:"legacy"`, `hold:true` listings owned by the tester, and runs `staleCheckService.run([String(tester.id)], new Date())`. The only id ever passed is the tester's, so only the tester receives the DM, with working buttons.
  Test cases are skipped (reply "run on the test bot") when `BOT_TOKEN` does not start with the test bot's prefix `9299714864:`.
- `syntheticLifecycle.ts`: refuses unless `BOT_TOKEN` starts with `9299714864:` and the `MONGO_URI` database name contains `Test`. Builds a real `Api` wrapped so that any call whose `chat_id` is not `278683632` throws and fails the run. Seeds: two legacy `hold` listings for user `278683632` (posts `approved`, no group message), one live `bot` listing aged 7 days. Runs: `staleCheckService.run(["278683632"], now)` (one real DM with the layout the owner will review), `lifecycle.tick(now)` with `nudges` on (one real nudge DM), then simulates the presses by calling `refreshListing` and `sellListing` directly and asserts: refreshed listing `live` with no `staleSentAt`; sold listing `sold` and its post `sold`. Prints PASS/FAIL per check, exits non-zero on any failure or any attempted send to another chat.

- [ ] **Step 1: Add the three `/test` cases**, run `pnpm run build`. Expected: compiles.
- [ ] **Step 2: Write `syntheticLifecycle.ts`** and run it against a throwaway Mongo with the local test token: `MONGO_URI=... pnpm exec ts-node src/tests/syntheticLifecycle.ts`. Check the token prefix without printing the token. Expected: all checks PASS, the owner receives the two DMs. Ask the owner for a visual look at the stale DM layout only; this is the dry run the owner uses to write the final text.
- [ ] **Step 3: Update docs.** README: lifecycle features (nudge, expiry, relist, trust line, `/stalecheck`) and the Commands table. CHANGELOG: an "Unreleased" entry, covering the `nudges` rollout order and that approved bot posts stay `approved` when a listing expires. Agents.md: new files, the `lc_`/`sc_` callbacks, `/stalecheck` in the Commands table. No version bump (the release is cut by the owner).
- [ ] **Step 4: Full verification:** `pnpm run lint && pnpm run build && MONGO_URI=... pnpm test`. Expected: exit 0, "Tests passed", no `[SKIP]`. Also run `pnpm run check-locals` once more and grep `src/locales/he` for `נשק` (must find nothing).
- [ ] **Step 5: Commit, push, open the PR** to master (or to the slice 2 branch if that is not merged yet). The PR body covers: scope, the answers to the Global Constraints list, the Decisions section, the Review Focus results, test output, and the rollout order below. Don't merge.

## Rollout (owner gates, nothing automatic)

1. Deploy slice 3 with `nudges: false`. Legacy listings stay on `hold`, nothing is sent, expiry now runs for non-hold listings only.
2. The owner runs `/stalecheck` on the **test bot**, reads the dry run, writes the final text (locale files, a small PR or direct edit), then runs "Stale-check dry run (to me only)".
3. On prod: `/stalecheck <pilot ids>` (ids typed by the owner, never stored in the repo), wait for answers, then `/stalecheck` for the rest. Unanswered listings expire 7 days after each send.
4. `/config nudges true` only on the owner's go-ahead. The 25-per-tick cap spreads the first batch over several ticks.
