# Slice 1: Trust-Based Moderation, Reject Reasons, Take Down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New sellers keep today's moderation card, trusted sellers publish at once and get reviewed after the fact, every reject carries a reason, moderators can take a listing down, and nothing containing a blocked word reaches the preview.

**Architecture:** Trust is a repository query (`isTrustedSeller`), never a stored flag. A new `PublishService` owns "a post becomes public" (publish, create the `bot` listing, tell the author) and the new-vs-trusted decision, so the wizard, the moderator's Approve button and the `/test` cases share one path. Reject keeps the atomic `claimPending`, then a second atomic claim (`claimRejectionNotice`) makes "tell the author, once" safe against a preset press racing a typed reply. Take-down is a small service over `listingRepository`. The blocked-word check sits at the wizard's preview step.

**Tech Stack:** TypeScript, node-telegram-bot-api 2.3.0 (v2 middleware chain), mongoose 9. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-market-design.md` (sections 5.5, 9.1, 9.3, 9.4, 13 "Slice 1", 15; read 5.2–5.4, 5.6 and 6.6 too). **Slice 0 plan:** `docs/superpowers/plans/2026-11-04-slice0-market-core.md`. This slice consumes its interfaces by name: `listingRepository` (`findByPostId`, `createForPost`, `markSold`), `IListing` (`status`, `source`, `origin`, `sellerId`, `postId`, `endedAt`, `endedBy`, `hold`), `findBlockedWord`, `BotConfig.rulesUrl`, `LEGACY_CUTOFF`, `reconcileBotListings`.

## Global Constraints

- Branch `feat/slice1-moderation` cut from `feat/slice0-market-core` (not master). Slices 0 and 1 release together as 3.0.0: open the PR with base `feat/slice0-market-core` (or master once slice 0 has merged). Don't merge without the owner.
- Follow `Agents.md`: services hold logic, repositories hold every Mongoose query, types in `src/types/index.ts`, no `any`, `[ERROR - <context>]` logs, v2 params-object API calls, no per-user flow state in memory.
- Additive data only: `posts` gets one new optional field (`rejectionNotifiedAt`) and `drafts` gets one (`fixing`). No existing field changes meaning, so the 2.0.1 image still runs. Known rollback caveat, written into the CHANGELOG: 2.0.1 doesn't know a listing is `taken_down`, so a seller could Bump a taken-down post there.
- Reject keeps the atomic claim. The post is claimed `rejected` on the Reject press, as today; the author is told exactly once, guarded by `claimRejectionNotice`.
- Callback formats are frozen once shipped: `rr_<postId>_<n>` and `td_<listingId>` are pinned in `src/tests/checkCallbackData.ts`, both ≤ 64 bytes. `skip_reason_*` keeps working (old prompts in the moderation topic and in `bot_sessions` live up to 3 days).
- Constants in code, not config: trust revoked for 90 days after a moderator take-down; 4 reject presets.
- Blocked words apply to everyone, trusted sellers included. No `he` locale string may contain a blocked word (`check-locals` enforces it). The runtime notice that names the word is a private DM, not something the bot publishes.
- Every new user-facing string goes into `en`, `he` and `ru` `common.json`. The owner rewrites user-facing text later, so keep it plain and short. Hebrew never calls replicas weapons.
- Tests never use the production token or database. Mongo-gated checks run against a throwaway `mongo:8.2` (`docker run -d --rm --name s1-mongo -p 127.0.0.1:27031:27017 mongo:8.2`, `MONGO_URI=mongodb://127.0.0.1:27031/SalesBotTestDB`). A run that prints `[SKIP]` for them is not a pass.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the executing model's line).

## Decisions this plan makes (spec silent or in tension; the owner may overturn)

1. **Any MOD may press a preset**, not only the moderator who pressed Reject. `skip_reason_*` names its moderator because the reply marker lives in that moderator's session; `rr_<postId>_<n>` carries the post id, and the DB (`claimRejectionNotice`) is the guard. The stored `rejectionReason` is the preset text in `config.lang`; the author's notice uses the preset in the author's own language.
2. **Bump and Sold are refused on a taken-down post.** Spec 5.2 keeps the post `approved` after a take-down, and today's Bump would re-post it publicly. `myPostsService` checks the listing.
3. **`/start sell` minimally works in this slice** (starts the wizard), because the reject notice's "Fix and resend" button deep-links to it. Slice 5 replaces it with the one-message flow.
4. **The "Fix and resend" and rules buttons are on every reject notice**, including the old Skip and typed-reason paths.
5. **A take-down deletes only the post's current `approvedMessageId`.** Older bumped copies of the same post stay in the group (today's Bump never deletes the previous copy). Accepted for 3.0 and listed in Review Focus.
6. **Every published card carries Take down** (D4: moderators can take any listing down). The trusted card has it from the start, and when a moderator approves a post, the existing card edit to "approved" adds the same `td_<listingId>` button (reviewer's correction to the draft).
7. **A draft sitting at the preview when 3.0 deploys** was never blocked-word checked. `submitPost` re-checks the saved fields and sends such a post to the moderation card even for a trusted seller.

## Review Focus

1. **A late typed reply after a preset won.** Moderator A presses a preset while moderator B (or A) has a live reply marker on the same prompt. The marker survives in the prompter's session (a different session from the presser's), so the later reply must hit the notice claim and be told "already handled", never DM the author twice. Test: Task 6 `typed reply after preset`; the cross-session case is only covered by this one test.
2. **Trusted publish half-fails.** Failure *before* the group message exists must fall back to the moderation card (the post is not lost). Failure *after* it (listing creation, trusted card) must keep the post approved and never fall back, or the post would publish twice. Test: Task 4 `publish failure falls back`; the after-publish half is untested by design (best-effort, logged).
3. **Pre-deploy drafts and trusted + blocked word.** A draft saved at the confirm step before this release was never checked. The trusted route must not skip the blocked-word guard. Test: Task 7 `trusted seller blocked word`.
4. **Take-down side effects that go wrong.** The group message already deleted by a human, the seller blocked the bot, and a post bumped several times (old copies stay). The listing must end `taken_down` in every one of those cases. Tests: Task 5 `group message already gone`, `seller blocked the bot`; the bumped-copies gap is untested and accepted.
5. **Forged or foreign presses.** A non-moderator pressing `rr_` or `td_`, an out-of-range `n`, a `listingId` that belongs to a sold listing. Nothing may change and nobody is notified. Tests: Task 5 `td_ non-mod`, Task 6 `rr_ non-mod`, `rr_ bad n`. Seller-side Bump/Sold after a take-down is tested in Task 5.

---

### Task 1: Post model and repository groundwork

**Files:**
- Modify: `src/models/Post.ts` (`rejectionNotifiedAt`), `src/types/index.ts` (`Post.rejectionNotifiedAt?: Date | null`)
- Modify: `src/repositories/postRepository.ts`
- Modify: `src/tests/checkModerationClaim.ts`

**Interfaces:**
- Produces: `IPost.rejectionNotifiedAt?: Date | null`, schema `{ type: Date, default: undefined }` (absent, not null, on new posts; the claim filter `rejectionNotifiedAt: null` matches both).
- Produces: `postRepository.claimRejectionNotice(postId: string, reason: string | null): Promise<IPost | null>`: one atomic `findOneAndUpdate` on `{ _id, status: "rejected", rejectionNotifiedAt: null }` that sets `rejectionNotifiedAt = new Date()` and, when `reason` is non-null, `rejectionReason`; returns the document after the update, or `null` when the post isn't `rejected` or was already claimed.
- Produces: `postRepository.hasApprovedOrSold(userId: string): Promise<boolean>`.
- Existing `setRejectionReason` stays (the claim test and `clearpending` still use it).

- [ ] **Step 1: Write the failing assertions** in `checkModerationClaim.ts`, in the same `try` block, on a fresh post:
  - `claim notice needs rejected`: on a `pending` post, `claimRejectionNotice(id, "x")` → `null`.
  - `concurrent presets`: claim the post `rejected`, then `Promise.all` of four `claimRejectionNotice(id, "reason 1".."reason 4")` → exactly 1 non-null; the stored `rejectionReason` equals the winner's reason; `rejectionNotifiedAt` is a Date.
  - `skip after preset loses`: `claimRejectionNotice(id, null)` → `null`, and `rejectionReason` is unchanged.
  - `skip alone`: on another rejected post, `claimRejectionNotice(id, null)` → non-null with `rejectionReason` still `null`; a second call → `null`.
  - `hasApprovedOrSold`: false for a user with only `pending` and `rejected` posts; true after one is `approved`; true for `sold` only.
- [ ] **Step 2: Run** `MONGO_URI=... pnpm run check-claim`. Expected: FAIL (methods missing).
- [ ] **Step 3: Implement** the field and the two methods.
- [ ] **Step 4: Run** `MONGO_URI=... pnpm run check-claim && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(posts): atomic reject-notice claim and trust helper`.

### Task 2: Listing take-down repository and `isTrustedSeller`

**Files:**
- Modify: `src/repositories/listingRepository.ts` (slice 0)
- Create: `src/services/trustService.ts`
- Modify: `src/tests/checkMarket.ts`

**Interfaces:**
- Consumes: `IListing`, `listingRepository.createForPost`, `postRepository.hasApprovedOrSold`.
- Produces on `listingRepository`:
  - `findById(id: string): Promise<IListing | null>`
  - `takeDown(id: string, now: Date): Promise<IListing | null>`: atomic `findOneAndUpdate` from status `live` or `expired` to `taken_down` with `endedAt = now`, `endedBy = "moderator"`, and `$unset` of `text`, `media`, `title` (spec 5.3 privacy rule; the update runs no validators, so required fields may be unset). Returns the document as it was **before** the update (so the caller still has `source`, `postId`, `sellerId`), or `null` for any other status.
  - `hasModeratorTakedownSince(sellerId: string, since: Date): Promise<boolean>`: any listing, any `source`, with `status:"taken_down"`, `endedBy:"moderator"`, `endedAt > since`.
- Produces `trustService.ts`: `export const TRUST_REVOKE_MS = 90 * 24 * 60 * 60 * 1000` and `isTrustedSeller(sellerId: string, now: Date): Promise<boolean>` = `postRepository.hasApprovedOrSold(sellerId)` and not `hasModeratorTakedownSince(sellerId, now - TRUST_REVOKE_MS)`. Captured (`group`) listings never grant trust because only `posts` are consulted; a moderator take-down of any listing revokes it.

- [ ] **Step 1: Write the failing checks** in `checkMarket.ts` (test-run id prefix for sellers, cleaned in `finally`):
  - `takeDown moves live only`: a live listing → `takeDown(id, T)` returns the before-document (status `live`, still has `title`); stored: `status:"taken_down"`, `endedAt` equals T, `endedBy:"moderator"`, no `text`, `media` or `title`. A second `takeDown` → `null`. A `sold` listing → `null`. An `expired` listing → non-null.
  - `takeDown concurrent`: `Promise.all` of two `takeDown` on one live listing → exactly one non-null.
  - `trust table` (all with the same `now`):
    - seller with no posts → `false`
    - one `pending` post → `false`; one `rejected` → `false`
    - one `approved` post → `true`
    - one `sold` post only → `true`
    - a `group` listing live and no posts → `false` (captured listings don't count)
    - `approved` post + listing taken down at T → `isTrustedSeller(s, T + 90 d − 1 ms)` is `false`, `isTrustedSeller(s, T + 90 d)` is `true`
    - `approved` post + a *group* listing taken down at T → `false` at T + 1 d (any source revokes)
    - `approved` post + a listing ended by `endedBy:"seller"` (status `removed`) → `true`
- [ ] **Step 2: Run** `MONGO_URI=... pnpm run check-market`. Expected: FAIL.
- [ ] **Step 3: Implement** the three repository methods and `trustService.ts`.
- [ ] **Step 4: Run** `MONGO_URI=... pnpm run check-market && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: listing take-down repository and trusted-seller query`.

### Task 3: `PublishService` and the listing at approval

**Files:**
- Create: `src/services/publishService.ts`
- Modify: `src/services/moderationService.ts` (`handleApproval` delegates)
- Modify: `src/controllers/botController.ts` (construct `PublishService`, pass it to `ModerationService`)
- Modify: `src/tests/checkFlows.ts`

**Interfaces:**
- Consumes: `PostService.sendToApproved/formatPostRichMessage`, `postRepository.setApprovedMessageId`, `listingRepository.findByPostId/createForPost`, `localeService`.
- Produces: `class PublishService { constructor(api: Api, config: BotConfig, postService: PostService) }` with
  - `publishApproved(post: Post, author: User): Promise<IListing | null>`: sends the post to the approved group exactly as `handleApproval` does today, stores `approvedMessageId`, then **best-effort**: finds or creates the `bot` listing (`createForPost(post, "dm", false, new Date())`; a duplicate-key error falls back to `findByPostId`) and DMs the author `postApproved` in the author's locale. An error from `sendToApproved` propagates (the caller releases the claim, as today). An error creating the listing or sending the DM is caught, logged `[ERROR - PublishService.publishApproved]`, and yields `null`/continues. Returns the listing or `null`.
- `ModerationService` constructor becomes `(api, config, postService, publishService, getBotUsername)`; `getBotUsername: () => string` is used from Task 6 (add the parameter now so the constructor changes once). `BotController` keeps a `private botUsername = ""`, set at the top of `registerRoutes`, and passes `() => this.botUsername`. Construct `PublishService` and `ModerationService` before `WizardService`.

- [ ] **Step 1: Write the failing check** in `checkFlows.ts`, new scenario `(m) a moderator approval creates the listing`: a new seller (no posts) seeds a `pending` post; a MOD presses `approve_<postId>` in the moderation group. Assert: `Listing` for `postId` exists with `source:"bot"`, `origin:"dm"`, `hold:false`, `status:"live"`, `sellerId` = author; the moderation card's approved-state edit carries one button `td_<listingId>` (Decision 6); post `approved` with `approvedMessageId` set; one `sendRichMessage` to `APPROVED_GROUP`; the author gets exactly one `sendMessage` with `T("postApproved")`; the moderator callback is answered with `T("adminApproved")`. Add `Listing` cleanup to the `finally`.
- [ ] **Step 2: Run** `MONGO_URI=... pnpm run check-flows`. Expected: FAIL (no listing).
- [ ] **Step 3: Implement** `PublishService.publishApproved`, switch `handleApproval` to call it (it keeps the `answerCallbackQuery` and the info log), and update the constructors.
- [ ] **Step 4: Run** `MONGO_URI=... pnpm run check-flows && pnpm run check-routes && pnpm run build`. Expected: PASS (all earlier scenarios unchanged).
- [ ] **Step 5: Commit** `feat: bot listing is created when a post is approved`.

### Task 4: Trusted sellers publish at once

**Files:**
- Modify: `src/services/publishService.ts`, `src/services/postService.ts`, `src/services/wizardService.ts`
- Modify: `src/controllers/botController.ts` (pass `PublishService` to `WizardService`)
- Modify: `src/locales/{en,he,ru}/common.json`
- Modify: `src/tests/checkFlows.ts`

**Interfaces:**
- Consumes: `isTrustedSeller`, `findBlockedWord` (slice 0), `postRepository.claimPending/updateStatus/setModerationMessageId`, `listingRepository`.
- Produces on `PublishService`: `submitPost(post: Post, data: PostData, trusted?: boolean): Promise<"published" | "moderation">`.
  - Decision: blocked word in the saved title, description, price or location → never trusted (Decision 7). Else `trusted ?? await isTrustedSeller(post.userId, new Date())`.
  - Not trusted → `postService.sendToModeration` and `setModerationMessageId`, return `"moderation"` (today's behaviour; the wizard still sends `postCreated`).
  - Trusted → `claimPending(id, "approved")`. A `null` claim (someone else handled it) logs a warning and returns `"published"` without anything else. Then `publishApproved`; if it throws before the group message exists, `updateStatus(id, "pending")`, fall back to the moderation card and return `"moderation"`. After a successful publish: `postService.sendTrustedCard(listing?._id ?? null, data)`, then `setModerationMessageId`, both best-effort (logged, never revert). Return `"published"`.
- Produces on `PostService`: `sendTrustedCard(listingId: string | null, data: PostData): Promise<number | null>`: the same rich message as the moderation card with `previewLabel = t(lang, "trustedPublishedLabel")`, sent to the moderation group/topic like `sendToModeration`, with one button `{ text: t(lang, "takeDownButton"), callback_data: "td_<listingId>" }`, or no keyboard when `listingId` is `null`.
- `WizardService` constructor gains `publishService: PublishService` (fifth parameter). `createPost` replaces its `sendToModeration` call with `submitPost`; it sends `postCreated` only when the result is `"moderation"` (a published post already got `postApproved`).
- New locale keys (en, he, ru): `trustedPublishedLabel` ("Published (trusted seller)"), `takeDownButton` ("🚫 Take down").

- [ ] **Step 1: Write the failing checks** in `checkFlows.ts`:
  - `(n) new seller gets a card`: a seller with no posts runs the wizard to Confirm. Assert: exactly one `sendRichMessage` to `MOD_GROUP` whose keyboard is `[approve_<id>, reject_<id>]`; none to `APPROVED_GROUP`; post `pending`; no `Listing`; the author gets `T("postCreated")`.
  - `(o) trusted seller publishes at once`: seed an `approved` post for the seller, then the wizard to Confirm. Assert: post `approved` with `approvedMessageId`; one `sendRichMessage` to `APPROVED_GROUP`; a `Listing` (`origin:"dm"`, `live`); the author gets `T("postApproved")` and **not** `T("postCreated")`; one `sendRichMessage` to `MOD_GROUP` that carries `T("trustedPublishedLabel")` in its JSON and a single button `td_<listingId>` (24-hex listing id, label `T("takeDownButton")`); the post's `moderationMessageId` equals that card's message id.
  - `(o2) publish failure falls back`: same trusted seller, but the harness answers `sendRichMessage` to `APPROVED_GROUP` with an error envelope (`{ok:false, error_code:500, description:"boom"}` through `createHarness({ responses })`; extend `boot()` to take the harness options). Assert: post is `pending` again, a moderation card with `approve_`/`reject_` was sent, the author got `postCreated`, and no `Listing` exists.
  - `(o3) pending and rejected posts don't make a seller trusted`: a seller with one `rejected` post still gets the card (`approve_`/`reject_`).
- [ ] **Step 2: Run** `MONGO_URI=... pnpm run check-flows`. Expected: FAIL.
- [ ] **Step 3: Implement** `submitPost`, `sendTrustedCard`, the wizard wiring and the two locale keys in all three languages.
- [ ] **Step 4: Run** `pnpm run check-locals && MONGO_URI=... pnpm run check-flows && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: trusted sellers publish instantly with a review card`.

### Task 5: Take down (`td_`)

**Files:**
- Create: `src/services/takeDownService.ts`
- Modify: `src/controllers/callbackRoutes.ts`, `src/controllers/botController.ts` (`dispatchCallback`)
- Modify: `src/services/myPostsService.ts` (Bump/Sold guards)
- Modify: `src/locales/{en,he,ru}/common.json`
- Modify: `src/tests/checkCallbackData.ts`, `src/tests/checkFlows.ts`

**Interfaces:**
- Consumes: `listingRepository.takeDown/findById/findByPostId`, `postRepository.findById/setApprovedMessageId`, `userService.hasAuthLevel`.
- Produces: `CallbackAction` gains `"takeDown"`; `routeCallback("td_<id>")` → `{ action: "takeDown", arg: "<id>" }`.
- Produces: `class TakeDownService { constructor(api: Api, config: BotConfig) }` with `handleCallback(query: CallbackQuery, listingId: string): Promise<void>`:
  1. `AuthLevel.MOD` required, else `answerCallbackQuery` with `notAdmin` (alert) and nothing else happens.
  2. `listingRepository.takeDown(listingId, new Date())`; `null` → toast `takeDownAlready`, nothing else.
  3. For `source === "bot"`: load the post; when it has `approvedMessageId`, `api.deleteMessage({ chat_id: approvedGroupId, message_id })`. A 400 "message to delete not found" counts as success; any other error is logged `[ERROR - TakeDownService.handleCallback]` and the take-down still stands. Then `setApprovedMessageId(postId, null)`. The post stays `approved`.
  4. DM the seller `takeDownNotice` (param `{title}` = the post title, seller's locale) when a `users` doc exists; a send error (403 blocked) is logged as a warning and ignored. A `group` listing's member message is never touched.
  5. Toast `takeDownDone`; best-effort `editMessageText` on the card to `statusTakenDown` (removes the button).
- `myPostsService.handleSoldCallback` and `handleBumpCallback`: after the ownership check, `listingRepository.findByPostId(postId)` with `status === "taken_down"` → `answerCallbackQuery` with `postTakenDown` (alert) and return, before any state change.
- New locale keys (en, he, ru): `takeDownDone`, `takeDownAlready`, `takeDownNotice` (`{title}`), `statusTakenDown`, `postTakenDown`.

- [ ] **Step 1: Write the failing tests.**
  - `checkCallbackData.ts`: golden rows `td_65f1c2a9e4b0c3d2a1f09876` → `{ action: "takeDown", arg: "65f1c2a9e4b0c3d2a1f09876" }`; add the string to `generated` (≤ 64 bytes check).
  - `checkFlows.ts`, using the trusted-seller setup of Task 4 to get a real published post and card:
    - `(p) take down`: a MOD presses the card's `td_<id>`. Assert: listing `taken_down`, `endedBy:"moderator"`; exactly one `deleteMessage` with `chat_id = APPROVED_GROUP` and `message_id` = the post's old `approvedMessageId`; post `approved` with `approvedMessageId` null; the seller gets one DM `T("takeDownNotice")` with the post title substituted; the callback is answered `T("takeDownDone")`; the card gets an `editMessageText` with `T("statusTakenDown")`.
    - `(p2) second press`: pressing again → toast `T("takeDownAlready")`, no second `deleteMessage`, no second DM.
    - `(p3) td_ non-mod`: a plain user and the seller each press `td_` on a live listing → toast `T("notAdmin")`, listing still `live`, no `deleteMessage`, no DM.
    - `(p4) taken down means untrusted`: the seller finishes the wizard again → a moderation card (`approve_`/`reject_`), not an instant publish.
    - `(p5) seller Bump and Sold refused`: the seller presses `bump_<postId>` and `sold_<postId>` → toast `T("postTakenDown")` each time, no `sendRichMessage` to `APPROVED_GROUP`, post still `approved` with `approvedMessageId` null.
    - `(p6) group message already gone`: `createHarness` answers `deleteMessage` with `{ok:false, error_code:400, description:"Bad Request: message to delete not found"}` → listing still `taken_down`, toast `T("takeDownDone")`, the seller still gets the DM.
    - `(p7) seller blocked the bot`: `sendMessage` to the seller's chat answers `{ok:false, error_code:403, description:"Forbidden: bot was blocked by the user"}` → listing `taken_down`, `deleteMessage` was called, toast `T("takeDownDone")`.
    - `(p8) sold listing`: press `td_` on a listing whose status is `sold` → toast `T("takeDownAlready")`, status stays `sold`.
- [ ] **Step 2: Run** `pnpm run check-callbacks` and `MONGO_URI=... pnpm run check-flows`. Expected: FAIL.
- [ ] **Step 3: Implement** the route, `TakeDownService`, the guards, the dispatch branch and the locale keys.
- [ ] **Step 4: Run** `pnpm run check-locals && pnpm run check-callbacks && MONGO_URI=... pnpm run check-flows && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: moderator take-down (td_) and guards on taken-down posts`.

### Task 6: Reject reasons: presets, atomic notice, author buttons

**Files:**
- Modify: `src/services/moderationService.ts`
- Modify: `src/controllers/callbackRoutes.ts`, `src/controllers/botController.ts` (`dispatchCallback` branch; `/start sell`)
- Modify: `src/locales/{en,he,ru}/common.json`
- Modify: `src/tests/checkCallbackData.ts`, `src/tests/checkFlows.ts`

**Interfaces:**
- Consumes: `postRepository.claimRejectionNotice` (Task 1), the `getBotUsername` constructor parameter (Task 3), `config.rulesUrl` (slice 0), `wizardService.handleNewPost`.
- Produces: `CallbackAction` gains `"rejectReason"`; `routeCallback("rr_<postId>_<n>")` → `{ action: "rejectReason", arg: "<postId>_<n>" }`. `skip_reason_*` still returns `null` from `routeCallback` (handled before routing by `handleSkip`).
- Prompt: `askRejectReason` sends `rejectReasonPrompt` with four keyboard rows `{ text: t(lang, "rejectPreset<n>"), callback_data: "rr_<postId>_<n>" }` for n = 1..4, and no Skip button. It still registers `expectReply` **and** `expectCallback` on the prompt id and the `pendingRejects` mirror, so `/cancel`, a typed reply and a legacy-format Skip press all keep one code path.
- Produces on `ModerationService`:
  - `handleReasonCallback(ctx: Context, query: CallbackQuery, arg: string): Promise<void>`: `arg` must match `^[0-9a-f]{24}_[1-4]$`, else toast `staleButton`. Requires `AuthLevel.MOD` (else `notAdmin` alert, no change). Calls `finishRejection` with the preset. Result `"handled"` → toast `adminPostHandled`; `"missing"` → toast `adminPostNotFound`; otherwise the toast is `adminRejected` and the prompt message is edited with `editMessageText` to `statusRejected` plus a newline and the reason text in `config.lang` (plus `authorNotNotified` when the result is `"unreachable"`), which also removes its keyboard. If the presser has a live marker for this prompt (`matchCallback` with `{ once: true }` hits), also `forgetReply` and drop the `pendingRejects` entry.
  - `finishRejection(postId: string, reason: { preset: 1 | 2 | 3 | 4 } | { text: string } | null, admin: { id: number; username?: string }): Promise<"notified" | "unreachable" | "handled" | "missing">` (private): the claim comes first, `claimRejectionNotice(postId, storedReason)` with `storedReason` = the preset text in `config.lang`, the typed text, or `null`; a `null` claim returns `"handled"` and sends nothing. Then the DM to the author in the author's locale: `postRejectedWithReason + <reason in the author's locale>` (preset text via `rejectPreset<n>` in the author's locale) or `postRejected` when there is no reason, with `reply_markup` from `buildRejectNoticeKeyboard`. A DM error is caught and logged, and returns `"unreachable"`.
  - `buildRejectNoticeKeyboard(locale: string): InlineKeyboardMarkup` (private): row 1 a URL button `rejectFixButton` → `https://t.me/<getBotUsername()>?start=sell`; row 2 only when `config.rulesUrl` is non-empty, a URL button `rejectRulesButton` → `config.rulesUrl`.
  - `handleRejectReply` and `handleSkip` now call `finishRejection`; on `"handled"` the reply path sends `adminPostHandled` into the topic (consumed, returns `true`), the skip path answers the toast `adminPostHandled`.
- `/start sell` (BotController): the `start` command passes its args; payload `sell` in a private chat calls `this.wizardService.handleNewPost(msg)`, anything else keeps the greeting.
- Locale keys (en, he, ru): `rejectReasonPrompt` (text changed: choose a reason below, or reply to this message with your own), `rejectPreset1..4`, `rejectFixButton`, `rejectRulesButton`, `authorNotNotified`. The Hebrew presets are exactly `חסר מחיר`, `תיאור ו\או תמונות לא ברורות` (a literal backslash, so `"\\"` in the JSON), `פריט לא חוקי`, `כפילות של מודעה קיימת - אפשר להקפיץ או להמתין`. English: `Missing price`, `Unclear description and/or photos`, `Item not allowed`, `Duplicate of an existing listing - bump it or wait`. Russian: `Не указана цена`, `Описание и/или фото неясны`, `Недопустимый товар`, `Дубликат существующего объявления - поднимите его или подождите`. `skipReasonButton` stays in the files (parity, legacy).

- [ ] **Step 1: Write the failing tests.**
  - `checkCallbackData.ts`: golden rows `rr_<ID>_1` → `{ action: "rejectReason", arg: "<ID>_1" }` and `rr_<ID>_4` likewise; add both to `generated`. The existing row `["skip_reason_abc", null]` stays.
  - `checkFlows.ts`, updating the existing scenarios and adding new ones (seed the author with `preferredLocale: "en"` so the author text is checkable as `localeService.t("en", ...)`):
    - Update `(h)`: the prompt keyboard is now four buttons whose data are `rr_<postId>_1..4` (no `skip_reason_`), text `T("rejectReasonPrompt")`; the typed-reply half is unchanged (author gets `postRejectedWithReason + "Photos are too dark"`, Skip keyboard removed via `editMessageReplyMarkup`).
    - Update `(i)` to the legacy path: press a hand-built `skip_reason_<mod>_<Date.now()>` on the prompt message (the marker still exists). Same assertions as today: another moderator → `notYourButton`; the right moderator → the author gets `postRejected`; a second press → `staleButton`.
    - `(q) preset reason`: Reject, then the MOD presses `rr_<postId>_2`. Assert: post `rejected`, `rejectionReason === T("rejectPreset2")` (the `config.lang` text), `rejectionNotifiedAt` set; the author gets exactly one DM `localeService.t("en","postRejectedWithReason") + localeService.t("en","rejectPreset2")`; that DM's keyboard has a URL button `{ text: t("en","rejectFixButton"), url: "https://t.me/JSTS_testing_bot?start=sell" }`, and with `cfg.rulesUrl = ""` it has no second button, while with `cfg.rulesUrl = "https://t.me/airsoft_yad2/54833/115880"` it has a second URL button to exactly that link; the prompt got `editMessageText` containing `T("statusRejected")` and the preset text; the toast is `T("adminRejected")`. Also assert the Hebrew preset 2 literally: `localeService.t("he","rejectPreset2") === "תיאור ו\\או תמונות לא ברורות"`.
    - `(q2) typed reply after preset`: `mod` presses Reject (so `mod`'s session holds the reply marker), then **`otherMod`** presses `rr_<postId>_1` and wins. Then `mod` sends a typed reply to the prompt → the author still has exactly one DM (the preset one), the topic gets `T("adminPostHandled")`, `rejectionReason` is unchanged. (When the presser is the prompter, as in `(q)`, the press clears the marker, so a later reply is simply not a reply to anything.)
    - `(q3) two moderators, two presets`: Reject; then `Promise.all([press rr_..._1 as mod, press rr_..._3 as otherMod])` → the author gets exactly one DM; the stored reason is one of the two preset texts and matches the DM; exactly one toast is `T("adminRejected")` and the other `T("adminPostHandled")`.
    - `(q4) rr_ non-mod`: a plain user presses `rr_<postId>_1` → toast `T("notAdmin")`, `rejectionNotifiedAt` still absent, no DM; the MOD can still press afterwards and wins.
    - `(q5) rr_ bad n`: `rr_<postId>_9` and `rr_<postId>_0` → toast `T("staleButton")`, nothing changes.
    - `(q6) seller blocked the bot`: the DM errors with a 403 envelope → `rejectionNotifiedAt` set, the prompt is edited and contains `T("authorNotNotified")`, the toast is `T("adminRejected")`.
    - `(q7) /start sell`: a private `/start sell` from a new user → the title prompt (`T("welcome")`), and `/start` alone still sends `T("greeting")`.
- [ ] **Step 2: Run** `pnpm run check-callbacks` and `MONGO_URI=... pnpm run check-flows`. Expected: FAIL.
- [ ] **Step 3: Implement** the route, prompt, `handleReasonCallback`, `finishRejection`, the notice keyboard, the two call-site changes, `/start sell` and the locale keys.
- [ ] **Step 4: Run** `pnpm run check-locals && pnpm run check-callbacks && MONGO_URI=... pnpm run check-claim && MONGO_URI=... pnpm run check-flows && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: reject reasons as preset buttons, once-only author notice`.

### Task 7: Blocked words at the wizard preview

**Files:**
- Modify: `src/services/blockedWords.ts` (slice 0)
- Modify: `src/models/Draft.ts`, `src/repositories/draftRepository.ts`
- Modify: `src/services/wizardService.ts`
- Modify: `src/locales/{en,he,ru}/common.json`
- Modify: `src/tests/checkLocals.ts`, `src/tests/checkFlows.ts`

**Interfaces:**
- Consumes: `findBlockedWord`, `draftRepository.update/findByUserId`.
- Produces in `blockedWords.ts` (pure, no imports from services): `findBlockedField(fields: { title?: string; description?: string; price?: string; location?: string }): { field: "title" | "description" | "price" | "location"; word: string } | null`, checking in that order and returning the first hit.
- Produces: `IDraft.fixing?: boolean` (optional, additive, `default: undefined`); `DraftFields` gains `fixing`; `draftRepository.start` also `$unset`s `fixing`.
- `WizardService` (private): `previewOrFix(draft: IDraft, from: TelegramUser): Promise<void>`: when `findBlockedField` hits, send the notice (`blockedWordNotice` with `{field, word}`, where `field` is the localised field name), then re-send that field's step prompt (`sendStep` with `step` set to the field) and `draftRepository.update(userId, { step: field, promptMessageId, fixing: true })`; no preview is sent. Otherwise send the preview and update `{ step: "confirm", promptMessageId, fixing: undefined }`.
  - The `done` button case calls it after the `minimumPhotos` check, instead of `sendPreview` directly.
  - `handleMessage`: for a text step on a draft with `fixing: true`, after the usual empty-text and price validation, store the field (and `descriptionEntities` for a description), then call `previewOrFix` with the updated draft instead of advancing along `NEXT_STEP`. Still-blocked text asks again; clean text goes straight back to the preview.
- Locale keys (en, he, ru): `blockedWordNotice` (`{field}`, `{word}`; for `he` the template itself must not contain a blocked word), `fieldTitle`, `fieldDescription`, `fieldPrice`, `fieldLocation` (reuse existing keys if the locale files already have them).

- [ ] **Step 1: Write the failing tests.**
  - `checkLocals.ts` (no Mongo): `findBlockedField({ title: "מחזיק לנשק", location: "נשק" })` → `{ field: "title", word: "נשק" }`; `findBlockedField({ title: "M4", description: "כולל נשק", price: "900", location: "מרכז" })` → `{ field: "description", word: "נשק" }`; `findBlockedField({ title: "M4", price: "900" })` → `null`; `findBlockedField({})` → `null`.
  - `checkFlows.ts`:
    - `(r) blocked title stops at the preview`: a new seller runs the wizard with title `"מחזיק לנשק"`, two photos, presses done. Assert: no `sendRichMessage` to the user's chat; the user gets `localeService.t(cfg.lang, "blockedWordNotice", { field: T("fieldTitle"), word: "נשק" })` then the title prompt (starts with `T("welcome")`); draft `step:"title"`, `fixing:true`; no `Post`.
    - `(r2) still blocked asks again`: the user answers `"נשק למכירה"` → the notice again, draft still `title`, `fixing:true`.
    - `(r3) fixed text returns to the preview`: the user answers `"מחזיק"` → a `sendRichMessage` preview to the user's chat with `confirm_`/`cancel_` buttons, draft `step:"confirm"`, `fixing` absent, title `"מחזיק"`, description/price/location untouched. Confirm then creates the post normally.
    - `(r4) each field`: a blocked description, price (`validatePrice` off for this case) and location each stop at the preview and re-ask their own step prompt (`enterDescription`, `enterPrice`, `enterLocation`).
    - `(r5) trusted seller blocked word`: a trusted seller (seeded approved post) with a blocked description is stopped at the preview too; nothing is published; no `sendRichMessage` to `APPROVED_GROUP`.
    - `(r6) draft saved before the release`: insert a `Draft` directly at `step:"confirm"` containing a blocked title, for a trusted seller, with `promptMessageId` of a fake preview; press its `confirm_` button. Assert: the post is created `pending`, a moderation card (`approve_`/`reject_`) goes to `MOD_GROUP`, nothing goes to `APPROVED_GROUP`, the seller gets `T("postCreated")`.
    - `(r7) restart while fixing`: after `(r)`, `boot()` a fresh controller and `/newpost` → Continue → the title prompt is re-sent and the draft is still `fixing`.
- [ ] **Step 2: Run** `pnpm run check-locals` and `MONGO_URI=... pnpm run check-flows`. Expected: FAIL.
- [ ] **Step 3: Implement** the helper, the draft field, `previewOrFix` and the wiring, and the locale keys.
- [ ] **Step 4: Run** `pnpm run check-locals && MONGO_URI=... pnpm run check-flows && pnpm run build`. Expected: PASS (`(r6)` passes because of the `submitPost` guard from Task 4).
- [ ] **Step 5: Commit** `feat(wizard): stop blocked words at the preview`.

### Task 8: `/test` cases and the synthetic reject on the test groups

**Files:**
- Modify: `src/tests/testCases.ts`
- Create: `src/tests/syntheticModeration.ts` (run manually, not part of `pnpm test`)

**Interfaces:**
- Consumes: `PublishService.submitPost` (constructed inline: `new PublishService(api, config, postService)`, so `TestCaseFn` doesn't change), `postRepository.createPost`.
- Produces `/test` cases: `trusted_seller_post` labelled "⭐ Post as trusted seller": creates a test post from the tester (same texts and media as `testCase1_FullPost`) and calls `submitPost(post, data, true)`; replies with the outcome, the post id and the listing id. `new_seller_post` labelled "🆕 Post as new seller": same post, `submitPost(post, data, false)`, so the moderation card appears. Both only make sense with the test bot's `config.json`; the label text says so in the confirmation message ("test groups only").
- `syntheticModeration.ts`: refuses to run unless `BOT_TOKEN` starts with `9299714864:` (the test bot) **and** `MONGO_URI` contains `Test`. It builds a `Bot` with the real token and a fetch wrapper that fakes only `answerCallbackQuery` (callback ids are fake) and sends everything else to Telegram. It sets `moderationGroupId = -1002474192098`, `moderationTopicId = 15`, `approvedGroupId = -1002445943058`, `approvedTopicId = 73`, `rulesUrl = ""`, seeds owner user `278683632` as MOD and author, seeds a `pending` post by the owner, sends it with `sendToModeration`, then feeds `bot.handleUpdate` a `reject_<id>` callback from the owner in the moderation group using the real card message id, reads the prompt's `message_id` from the wrapper's recorded `sendMessage` result, and feeds `rr_<id>_1` against it. It exits non-zero unless the post ends `rejected` with `rejectionReason` equal to the `config.lang` text of `rejectPreset1`, the DM to the author succeeded, and no message went to the approved group. Print what it sent (chat, topic, message id), never the token.

- [ ] **Step 1: Add the two `/test` cases**, run `pnpm run build`. Expected: compiles.
- [ ] **Step 2: Write `syntheticModeration.ts`** and run it against a throwaway Mongo with the local `.env` test token: `MONGO_URI=mongodb://127.0.0.1:27031/SalesBotTestDB pnpm exec ts-node src/tests/syntheticModeration.ts`. Check the token prefix first without printing the token. Expected: exit 0, the prompt with four preset buttons and the edited result visible in topic 15 of the moderation test group, and a DM with the reason and the "Fix and resend" button to the owner. Ask the owner for a visual glance only.
- [ ] **Step 3: Run the two `/test` cases on the test bot** (owner presses them in DM): the trusted case shows a published post in the user-facing test group and a "Published (trusted seller)" card with Take down in topic 15; pressing Take down deletes that post and removes the button. The new-seller case shows the normal card. Record the observations for the PR.
- [ ] **Step 4: Commit** `test: /test cases for trusted and new sellers, synthetic preset reject`.

### Task 9: Documents, version, verification, PR

**Files:**
- Modify: `Agents.md`, `docs/README.md`, `docs/CHANGELOG.md`, `package.json` (version `3.0.0`), `README.md` if it lists features

**Interfaces:** none.

- [ ] **Step 1: Agents.md.**
  - Replace "Don't bypass the moderation flow: posts must pass through `moderationGroupId` before appearing in `approvedGroupId`" with: new sellers' posts pass through `moderationGroupId` before they appear in `approvedGroupId`; trusted sellers' posts (an approved or sold post, no moderator take-down in the last 90 days) publish at once and are reviewed after publishing through the "Published (trusted seller)" card; nothing else may publish to `approvedGroupId` without one of these two paths.
  - Post Lifecycle diagram: add the trusted branch, the preset reject reasons, take-down.
  - Repository Structure: `publishService.ts`, `trustService.ts`, `takeDownService.ts`; `posts.rejectionNotifiedAt` and `drafts.fixing` are additive.
  - Callback list: `rr_` and `td_` are frozen formats. "Do": a new "tell the author once" path must go through `claimRejectionNotice`.
- [ ] **Step 2: README and CHANGELOG.** README: trusted-seller publishing, reject presets, take down, blocked-word check. CHANGELOG: turn the slice 0 "Unreleased" entry and this slice into one `3.0.0` entry (Added, Changed, Notes). Notes must state the rollback caveat (2.0.1 can Bump a taken-down post), that `docs/BACKUP.md`'s mongodump comes first, and that deploys need the owner's go-ahead.
- [ ] **Step 3: Version.** Set `package.json` `version` to `3.0.0`.
- [ ] **Step 4: Full verification:** `pnpm run lint && pnpm run build && MONGO_URI=... pnpm test`. Expected: exit 0, "Tests passed", no `[SKIP]`.
- [ ] **Step 5: Commit, push, open the PR** (base `feat/slice0-market-core`, or master after slice 0 merges). The PR body covers: scope, the seven decisions above, the review-focus results, test output, the synthetic run in topic 15, the owner glance results. Don't merge, don't deploy.
