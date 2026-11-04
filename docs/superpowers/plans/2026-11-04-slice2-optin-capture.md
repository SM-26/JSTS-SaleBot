# Slice 2: Opt-in Capture Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a member posts a sale in the sale topic, the bot privately offers "Add to the market?" (an ephemeral note). Add creates a live `group` listing the seller manages from the note, from the DM (`start=l_`) and from `/myposts`. Incomplete posts finish in the bot through `start=c_`.

**Architecture:** The slice 0 sweeper already closes capture windows and classifies them. This slice hangs one hook (`OnClassified`) on `shadowService` that decides: refresh a repost, stay silent, or send the note. A thin `ephemeralNotes` module wraps the three Bot API calls. `GroupListingService` owns every listing action (Add, Sold, Refresh, Remove, edit-sync) and every card; `CaptureNoteService` owns the note send and the `mk_` buttons. Prefilled drafts reuse the wizard's step machine. All state is in Mongo (`captures`, `listings`, `members`, `drafts`).

**Tech Stack:** TypeScript, node-telegram-bot-api 2.3.0 (v2 middleware chain), mongoose 9, Node stdlib. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-market-design.md` (sections 5.1–5.6, 6.1–6.7, 8.2, 8.3, 9.2, 11.2, 13 "Slice 2", 15). Slice 0 plan: `docs/superpowers/plans/2026-11-04-slice0-market-core.md`. Slice 1 plan: `docs/superpowers/plans/2026-11-04-slice1-moderation.md` (provides `td_<listingId>` take-down; its handler is not changed here). Read all three before Task 1.

## Global Constraints

- Branch `feat/slice2-optin` from the slice 1 branch (`feat/slice1-moderation`; confirm the name in the slice 1 plan). Slices 0 and 1 must be in the base. One PR to master (stacked on slice 1 until it merges); don't merge without the owner.
- Follow `Agents.md`: services hold logic, repositories hold every Mongoose query, types in `src/types/index.ts` or beside the model, no `any`, `[ERROR - <context>]` logs, v2 params-object API calls, state in Mongo only (no `Map` for a flow).
- Additive data only: new optional fields on `captures`, `members`, `drafts`, `listings`. Nothing changes in `posts`/`users`. The 2.0.1 image must still run: it ignores the new `drafts` fields (a 2.0.1 wizard on a capture draft would post it as a bot post, so the `/start c_` handler refuses to overwrite a live draft, and 2.0.1 never creates capture drafts).
- Names from slice 0 are used exactly: `ICapture` (states `open|closed|classified|asked|added|declined|ignored`), `IListing`, `IMember`, `captureRepository`, `listingRepository`, `memberRepository`, `classify`, `normalize`, `textHash`, `tokenOverlap`, `Tier`, `Parsed`, `ClassifyResult`, `shadowService.processOneClosed`/`tick`, `CaptureService`, `startSweeper`, `findBlockedWord`. Names from slice 1: the `td_<listingId>` callback.
- Nothing is posted publicly by this slice (D10). The only outgoing messages are: private notes to the seller (sale topic), DMs the user asked for (`/start c_`, `/start l_`, `/myposts`), and one card to the moderation topic for a new seller's first captured listing.
- `captureMode: optin` is the only switch. `off` and `shadow` send no note. Existing listings keep being maintained (Sold/Refresh/Remove/edits) in every mode.
- Constants in code: notes per seller per 24 h = 3, decline memory 30 days (20 hashes max), note rolling window 24 h, ask/refresh note kinds both count toward the cap.
- Telegram calls for notes (verified in `node_modules/.pnpm/node-telegram-bot-api@2.2.0/.../dist/core/api.d.ts` and `types/schemas.d.ts`; 2.3.0 keeps them): `api.sendMessage({ chat_id, text, reply_markup, message_thread_id?, ephemeral_message_parameters: { receiver_user_id } })` returns a `Message` whose `ephemeral_message_id?: number` is the note id; `api.editEphemeralMessageText({ chat_id, receiver_user_id, ephemeral_message_id, text, reply_markup })` and `api.deleteEphemeralMessage({ chat_id, receiver_user_id, ephemeral_message_id })`, both returning `boolean`. `CallbackQuery.message` is `MaybeInaccessibleMessage | undefined`; its shape for a press on a note is unverified, so no handler relies on it for a note (callback_data carries ids and the surface; the note id comes from Mongo).
- Prod sale topic has no thread id: note `message_thread_id` is set only when `Number(approvedTopicId) !== 1` (the convention in `postService`).
- Callback formats are frozen once shipped. New prefixes `mk_` and `ls_` are pinned in `src/tests/checkCallbackData.ts`, and every callback_data stays at or under 64 bytes. Start payloads `c_<id>` and `l_<id>` are pinned there too.
- Every new user-facing string goes into `en`, `he` and `ru` `common.json`. The owner rewrites text later: plain and short. No `he` string may contain a blocked word (`נשק`), and replicas are never called weapons. `check-locals` enforces parity and the blocked-word rule.
- Tests never use the production token or database. Mongo-gated checks run against a throwaway `mongo:8.2` (`docker run -d --rm --name s2-mongo -p 127.0.0.1:27032:27017 mongo:8.2`, `MONGO_URI=mongodb://127.0.0.1:27032/SalesBotTestDB`). A run that prints `[SKIP]` is not a pass.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the executing model's line).

## Review Focus

1. **The note never arrives, or arrives and its buttons can't be traced.** `sendMessage` may 403/400, or return no `ephemeral_message_id`; the real press may carry a `query.message` of an unknown shape. The capture must go back to `classified` (no retry, no crash), and handlers must work with no `query.message` at all. Tests: Task 5 `note send failure leaves capture classified`, Task 6 `press without query.message`.
2. **A member deletes their post after Add.** Telegram sends no update, so the listing stays live with a dead link (spec 15, accepted). Sold, Refresh and Remove must still work, and none of them may call Telegram on the group message. Test: Task 4 `remove never touches the group message`.
3. **Two quick reposts.** Reposts within one window join one capture (one refresh, one note). Reposts in separate windows give two refreshes, and exactly one live card must remain: the older note is deleted and `listing.note` points at the newest. Test: Task 5 `two reposts leave one card`.
4. **A note pressed after the capture's 7-day TTL**, or pressed twice. The capture row is gone: toast `staleButton`, no listing, no crash. A double tap on Add creates one listing. Tests: Task 6 `press after capture TTL`, `double Add is one listing`.
5. **A seller who never started the bot opens `l_<listingId>`.** The tap on the URL button opens the bot, `/start l_…` must create the `users` doc (middleware), resolve the default locale, and show the card; a different user with the same link gets "not found". Test: Task 7 `l_ opens for a fresh user`, `l_ foreign user refused`.

## Decisions made while planning (spec silent or in tension)

- **Decline memory (6.3 vs 7-day capture TTL).** The spec says a declined text is not asked again for 30 days, but `captures` expire after 7 days. Declines are therefore remembered as `members.declined: { hash, at }[]` (hash of the normalized text, newest 20, no member text). Matching is exact `textHash` only, since the spec says "same text".
- **"Notes today" (6.5)** is a rolling 24 hours, counted from `captures.note.sentAt` (kinds `ask` and `refresh`). A refresh note over the cap is skipped silently (the refresh itself still happens). At the cap the capture simply stays `classified`.
- **Repost of a `bot`-source listing in the group** does nothing (no refresh, no note): the bot's own post is the shop window, and bumping it is `/myposts`. Only `group` listings merge.
- **`askMode: never`** means no note of any kind, including "Refreshed ✓". The refresh still happens silently.
- **"Don't ask again" one-liner (6.5)** names `/myposts` → settings, with an "Open the bot" URL button. It does not mention `start=sell`: that payload arrives in slice 5 and never undoes the setting.
- **`/myposts` does not list un-added captures** (8.3 is silent; listing them would be a second nag). For a post whose note never arrived, the fallback until slice 5 is `/newPost`.
- **Callback shape.** `ls_<listingId>_<s|f|r>_<n|c|l>`: the last letter is the surface (note, DM card, `/myposts` line), so no handler infers the surface from `query.message`. `mk_<captureId>_<a|n|x>` for note buttons; `mk_set_ask` / `mk_set_never` for the `/myposts` settings row.
- **Capture drafts** (`captureId` set) skip the description, location and media steps and ignore `minimumPhotos`: they only ask for the first missing of title, price, then show the preview. A live non-capture draft blocks `/start c_` (the user is told to finish or `/cancel`).
- **First-seller moderation card (9.2):** sent when the seller had no listing of any source before this one (covers trusted bot sellers, and avoids depending on slice 1's trust query). The button is `td_<listingId>`.
- **Relist** is slice 3, so `/myposts` shows ended listings as one count line, no buttons.
- **Remove and Sold have no confirm step** (spec: one tap). Revisit only if the owner asks.

---

### Task 1: `optin`, callback routes and start payloads

**Files:**
- Modify: `src/services/configSchema.ts`, `src/tests/configSchema.check.ts`
- Modify: `src/controllers/callbackRoutes.ts`, `src/tests/checkCallbackData.ts`
- Create: `src/services/deepLinks.ts`

**Interfaces:**
- Produces: `CONFIG_SCHEMA.captureMode` values become `["off", "shadow", "optin"]` (`hybrid` still rejected).
- Produces: `CallbackAction` gains `"capture" | "listing"`. `routeCallback("mk_<rest>")` → `{ action: "capture", arg: "<rest>" }`; `routeCallback("ls_<rest>")` → `{ action: "listing", arg: "<rest>" }`.
- Produces (`deepLinks.ts`, pure): `type StartPayload = { kind: "c" | "l"; id: string }`; `parseStartPayload(args: string): StartPayload | null`, matching `^([cl])_([0-9a-f]{24})$` on the trimmed args; `deepLink(botUsername: string, payload: string): string` = `https://t.me/<botUsername>?start=<payload>`.

- [ ] **Step 1: Write failing assertions.** `configSchema.check.ts`: change slice 0's `("captureMode","optin")` row from `ok:false` to `{ok:true,value:"optin"}`, and add `("captureMode","hybrid")` → `ok:false`. `checkCallbackData.ts`, golden rows (literal, never edited later): `mk_${ID}_a`, `mk_${ID}_n`, `mk_${ID}_x` → `{action:"capture", arg:"${ID}_a|n|x"}`; `mk_set_ask` → `{action:"capture", arg:"set_ask"}`; `mk_set_never` likewise; `ls_${ID}_s_n`, `ls_${ID}_f_c`, `ls_${ID}_r_l` → `{action:"listing", arg:"${ID}_s_n"}` etc. Add all 3 actions × 3 surfaces and the three `mk_${ID}_*` rows to the generated-strings list that the 64-byte loop checks (longest is 31 bytes). Add `parseStartPayload` rows: `c_${ID}` → `{kind:"c",id:ID}`, `l_${ID}` → `{kind:"l",id:ID}`, `"c_"`, `"c_xyz"`, `"x_${ID}"`, `"garbage"`, `""` → `null`; and `deepLink("JSTS_testing_bot", "c_"+ID)` equals `https://t.me/JSTS_testing_bot?start=c_${ID}`.
- [ ] **Step 2: Run** `pnpm run check-config && pnpm run check-callbacks`. Expected: FAIL.
- [ ] **Step 3: Implement** the enum change, the two prefixes (placed after `donate_`; no existing prefix collides with `mk_`/`ls_`, and slice 0's `lb_` and slice 1's `rr_`/`td_` are distinct) and `deepLinks.ts`.
- [ ] **Step 4: Run** `pnpm run check-config && pnpm run check-callbacks && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: optin capture mode, mk_/ls_ routes, start payload parser`.

### Task 2: Data layer, harness support

**Files:**
- Modify: `src/models/Capture.ts`, `src/models/Member.ts`, `src/models/Draft.ts`, `src/models/Listing.ts` (only if a field below is missing)
- Modify: `src/repositories/captureRepository.ts`, `listingRepository.ts`, `memberRepository.ts`, `draftRepository.ts`
- Modify: `src/tests/harness.ts`, `src/tests/checkMarket.ts`

**Interfaces:**
- Model fields (all optional/additive): `ICapture.note?: { ephemeralMessageId: number; sentAt: Date; kind: "ask" | "refresh" }` (slice 0 declares `note?`; add `kind`); `ICapture.listingId?: string`. `IMember.declined?: { hash: string; at: Date }[]`. `IDraft.captureId?: string`, `IDraft.quick?: boolean`. `IListing.note?: { ephemeralMessageId: number; sentAt: Date }`.
- `captureRepository` adds:
  - `findById(id: string): Promise<ICapture | null>`
  - `transition(id: string, from: CaptureState[], to: CaptureState): Promise<ICapture | null>`: one atomic `findOneAndUpdate({_id, state:{$in:from}}, {$set:{state:to}}, {returnDocument:"after"})`
  - `setNote(id: string, note: { ephemeralMessageId: number; sentAt: Date; kind: "ask" | "refresh" }): Promise<void>`
  - `setListing(id: string, listingId: string): Promise<void>`
  - `countNotesSince(senderId: string, since: Date): Promise<number>`: captures of that sender with `note.sentAt >= since`
  - `noteStats(since: Date): Promise<{ notes: number; added: number; declined: number }>`: over captures with `note.kind === "ask"` and `note.sentAt >= since`; `added`/`declined` count by state
  - `insertClassified(input: { chatId: number; senderId: string; senderName: string; messageIds: number[]; text: string; media: IMediaItem[]; tier: Tier; parsed: Parsed; now: Date }): Promise<ICapture>`: state `classified`; used by checks and `/test`, never by production code
- `listingRepository` adds:
  - `findById(id: string): Promise<IListing | null>`
  - `findLiveByMessage(chatId: number, messageId: number): Promise<IListing | null>`: `source:"group", status:"live"`, `messageIds` contains it
  - `findGroupBySeller(sellerId: string): Promise<IListing[]>`: newest `createdAt` first
  - `countBySeller(sellerId: string): Promise<number>`: any source, any status
  - `createFromCapture(input: NewGroupListing, now: Date): Promise<IListing>` with `NewGroupListing = { chatId: number; messageIds: number[]; sellerId: string; sellerName: string; title: string; price: string; priceValue?: number; location?: string; text: string; textHash: string; media: IMediaItem[]; isBundle: boolean }`; `source:"group"`, `origin:"capture"`, `status:"live"`, `hold:false`, `createdAt = refreshedAt = now`
  - `refresh(id: string, now: Date, messageIds?: number[]): Promise<IListing | null>`: only from `live`/`expired`; sets `status:"live"`, `refreshedAt`, `$unset` `nudgedAt`, `endedAt`, `endedBy`; replaces `messageIds` when given
  - `endListing(id: string, status: "sold" | "removed", by: "seller" | "system", now: Date): Promise<IListing | null>`: only from `live`/`expired`; for `removed` also `$unset` `text`, `media`, `title`
  - `setNote(id: string, note: { ephemeralMessageId: number; sentAt: Date }): Promise<void>`
  - `applyEdit(id: string, patch: { title?: string; price?: string; priceValue?: number; location?: string; text: string; textHash: string; isBundle: boolean }): Promise<IListing | null>`: only while `live`
- `memberRepository` adds: `findByUserId(userId: string): Promise<IMember | null>`; `setAskMode(userId: string, mode: "ask" | "never", now: Date): Promise<void>` (upsert; `firstSeenAt` and `askMode` only via `$setOnInsert` when absent from `$set`, so no `ConflictingUpdateOperators`); `recordDecline(userId: string, hash: string, now: Date): Promise<void>` (`$push` with `$each` and `$slice: -20`, upsert); `hasDeclined(userId: string, hash: string, since: Date): Promise<boolean>`; `markNote(userId: string, now: Date): Promise<void>`.
- `draftRepository` adds `startFromCapture(input: { userId: string; chatId: number; locale: string; step: DraftStep; promptMessageId: number; captureId: string; title?: string; description?: string; price?: string; location?: string; media: IMediaItem[] }): Promise<IDraft>`: upsert replacing the user's draft, `quick: true`, `startedAt = updatedAt = now`.
- Harness: a `sendMessage` call whose params contain `ephemeral_message_parameters` returns the message plus `ephemeral_message_id` (a counter starting at 5000). `pressButton` gains `noMessage?: boolean` (omit `message` from the callback_query). `SendTextOptions` gains `caption?`, `messageThreadId?`, `mediaGroupId?`, `isBot?` and `sendPhoto` honours them (skip any that slice 0 already added). A `responses` function that returns `undefined` falls back to the default result for that method (so a check can fail only the ephemeral `sendMessage`).

- [ ] **Step 1: Write failing Mongo checks** in `checkMarket.ts` (test-run id prefix for cleanup):
  - `transition is atomic`: `Promise.all([transition(id,["classified"],"added"), transition(id,["classified"],"added")])` → exactly one non-null.
  - `countNotesSince`: three captures for one sender with `note.sentAt` of now-1 h, now-23 h, now-25 h → `countNotesSince(sender, now-24h)` is 2.
  - `noteStats`: one `ask` capture `added`, one `declined`, one `refresh` → `{notes:2, added:1, declined:1}`.
  - `decline memory`: 22 distinct `recordDecline` calls → `declined.length === 20` and the first two hashes are gone; `hasDeclined(newest, now-30d)` true; `hasDeclined(newest, now+1d)` false; `setAskMode("never")` then `touch` keeps `never`; `setAskMode` on an unseen user creates the member with `firstSeenAt`.
  - `refresh from expired`: an `expired` listing with `nudgedAt` → `refresh` returns it `live` with `nudgedAt` unset; a `sold` listing → `null`.
  - `endListing removed unsets text`: after `endListing(id,"removed","seller",now)` the row has `status:"removed"`, `endedBy:"seller"`, and no `text`, `title`, `media`; a second `endListing` → `null`; `endListing(id,"sold",…)` keeps `title`.
  - `findLiveByMessage` finds a listing by its second `messageId`, and returns `null` once it is `sold`. `countBySeller` counts a `sold` and a `legacy` listing. `applyEdit` on a `sold` listing → `null`.
  - `draft startFromCapture`: the stored draft has `captureId`, `quick:true`, the given step and media.
- [ ] **Step 2: Run** `MONGO_URI=... pnpm run check-market`. Expected: FAIL.
- [ ] **Step 3: Implement** the fields, repository methods and harness changes.
- [ ] **Step 4: Run** `MONGO_URI=... pnpm run check-market && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: data layer for opt-in capture`.

### Task 3: Cards, links and ephemeral wrappers

**Files:**
- Create: `src/services/listingCards.ts` (pure), `src/services/ephemeralNotes.ts`
- Modify: `src/services/deepLinks.ts`
- Modify: `src/locales/{en,he,ru}/common.json`
- Create: `src/tests/checkListingCards.ts` (no Mongo; script `check-cards` added to `test` after `check-callbacks`)

**Interfaces:**
- `type Translate = (key: string, params?: Record<string, string | number | boolean>) => string`; `type Surface = "n" | "c" | "l"`; `interface Card { text: string; keyboard: InlineKeyboardButton[][] }`.
- `listingCards.ts` produces:
  - `listingActionData(listingId: string, action: "s" | "f" | "r", surface: Surface): string` = `ls_${listingId}_${action}_${surface}`; `parseListingArg(arg: string): { listingId: string; action: "s" | "f" | "r"; surface: Surface } | null`
  - `captureActionData(captureId: string, action: "a" | "n" | "x"): string` = `mk_${captureId}_${action}`; `parseCaptureArg(arg: string): { captureId: string; action: "a" | "n" | "x" } | null`
  - `buildAskNote(t: Translate, capture: { id: string; parsed: Parsed }, botUsername: string): Card`: complete (title and price) → text `captureNoteComplete` with title, price, and ` · <location>` when present; one row `[Add (mk_.._a), Not now (_n), Don't ask again (_x)]`. Incomplete → text `captureNoteIncomplete`; first button is `{ text, url: deepLink(botUsername, "c_"+id) }` (no `callback_data`), then Not now and Don't ask again. Plain text, no parse mode.
  - `buildManagementCard(t: Translate, listing: Pick<IListing, "_id" | "title" | "price">, o: { botUsername: string; surface: "n" | "c"; refreshed?: boolean }): Card`: text `listingRefreshedCard` when `refreshed`, else `listingCard`; row 1 `[Sold (s), Refresh (f), Remove (r)]` with the given surface; surface `n` adds row 2 `[{ text: listingManageButton, url: deepLink(botUsername, "l_"+id) }]`, surface `c` has no second row.
  - `buildEndedCard(t: Translate, listing: Pick<IListing, "status" | "title">): Card`: `sold` → `listingSoldNote` with title; `removed` → `listingRemovedNote`; everything else → `listingEnded`. Empty keyboard.
  - `buildNeverNote(t: Translate, botUsername: string): Card`: text `captureNeverNote`, one URL button `captureOpenBotButton` → `https://t.me/<botUsername>`.
  - `escapeHtml(s: string): string` (`& < >`).
- `deepLinks.ts` adds (async or pure as noted): `getBotUsername(api: Api): Promise<string>` (`api.getMe()`, cached for the process); `groupMessageLink(chat: { id: number; username?: string }, topicId: number | null | undefined, messageId: number): string` (pure: public group → `https://t.me/<username>/<messageId>`, or `<username>/<topic>/<messageId>` when the topic is not 1; private → `https://t.me/c/<abs(id) without the 100 prefix>/<topic>/<messageId>`, topic omitted when it is 1 or unset); `resolveGroupLink(api: Api, config: BotConfig, messageId: number): Promise<string>` (`api.getChat` once per process, cached). If slice 0 already left an equivalent helper (the `/label` link builder), import it and drop this one.
- `ephemeralNotes.ts` (the only module that calls the three methods):
  - `sendNote(api: Api, config: BotConfig, receiverUserId: number, card: Card): Promise<number | null>`: `sendMessage` with the group id from `config.approvedGroupId`, `message_thread_id` only when `Number(config.approvedTopicId) !== 1`, `ephemeral_message_parameters: { receiver_user_id }`, `reply_markup: { inline_keyboard: card.keyboard }`. Returns `message.ephemeral_message_id`, or `null` (and logs `[ERROR - ephemeralNotes.send]`, naming the Telegram error) on a throw or a missing id.
  - `editNote(api: Api, chatId: number, receiverUserId: number, ephemeralMessageId: number, card: Card): Promise<boolean>`: `editEphemeralMessageText`; always passes `reply_markup: { inline_keyboard: card.keyboard }` (empty array removes buttons); catches, logs `[WARN - ephemeralNotes.edit]`, returns `false`.
  - `deleteNote(api: Api, chatId: number, receiverUserId: number, ephemeralMessageId: number): Promise<boolean>`: `deleteEphemeralMessage`, same catch.
- New locale keys (en, he, ru): `captureNoteComplete`, `captureNoteIncomplete`, `captureAddButton`, `captureCompleteButton`, `captureNotNowButton`, `captureNeverButton`, `captureNeverNote`, `captureOpenBotButton`, `captureAddedToast`, `listingCard`, `listingRefreshedCard`, `listingSoldNote`, `listingRemovedNote`, `listingEnded`, `listingSoldButton`, `listingRefreshButton`, `listingRemoveButton`, `listingManageButton`, `listingSoldToast`, `listingRefreshedToast`, `listingRemovedToast`, `captureExpired`, `captureDraftBusy`, `captureAlreadyAdded`, `capturePublished`, `myPostsGroupTitle`, `myPostsGroupEnded`, `myPostsAskOn`, `myPostsAskOff`, `myPostsAskStopButton`, `myPostsAskResumeButton`, `captureModCard`, `captureModTakeDown`, `statsOptin`. Placeholders are `{title}`, `{price}`, `{location}`, `{n}`, `{name}`, `{link}`, `{notes}`, `{added}`, `{rate}`. Reuse existing `staleButton`, `notYourButton`, `postNotFound`, `myPostsEmpty`.

- [ ] **Step 1: Write the failing check** `checkListingCards.ts` with an identity translator (`(k, p) => k + (p ? JSON.stringify(p) : "")`) so it needs no config:
  - `ask note complete`: for `{ id: ID, parsed: { title: "גלוק 17", price: "1,300₪", location: "מרכז", isBundle: false } }` the text starts with `captureNoteComplete` and contains `"title":"גלוק 17"`; keyboard is one row whose `callback_data` are exactly `[mk_${ID}_a, mk_${ID}_n, mk_${ID}_x]`.
  - `ask note incomplete`: parsed with no title → first button `url === "https://t.me/JSTS_testing_bot?start=c_" + ID` and `callback_data` undefined; the other two are `mk_${ID}_n`, `mk_${ID}_x`. Same when the price is missing.
  - `management card n`: row 1 data `[ls_${ID}_s_n, ls_${ID}_f_n, ls_${ID}_r_n]`; row 2 is one URL button `https://t.me/JSTS_testing_bot?start=l_${ID}`. `management card c`: one row only, data end in `_c`. `refreshed:true` switches the text key to `listingRefreshedCard`.
  - `ended card`: `sold` → starts with `listingSoldNote`, `removed` → `listingRemovedNote`, `taken_down` and `expired` → `listingEnded`; keyboard `[]` for all.
  - `never note`: one row, one URL button `https://t.me/JSTS_testing_bot`.
  - `parse round trip`: `parseListingArg(ID + "_f_c")` → `{listingId:ID, action:"f", surface:"c"}`; `"${ID}_x_c"`, `"${ID}_s_z"`, `"zz_s_n"` → `null`; `parseCaptureArg(ID+"_x")` → `{captureId:ID, action:"x"}`, `"set_ask"` → `null`.
  - `every callback_data <= 64 bytes` over every keyboard built above.
  - `groupMessageLink`: `({id:-1002445943058, username:undefined}, 73, 9)` → `https://t.me/c/2445943058/73/9`; `({id:-1001, username:"airsoft_yad2"}, 1, 5)` → `https://t.me/airsoft_yad2/5`; topic 73 with a username → `https://t.me/airsoft_yad2/73/5`.
  - `escapeHtml("a<b>&")` → `a&lt;b&gt;&amp;`.
- [ ] **Step 2: Run** `pnpm run check-cards`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the modules and the locale keys (en, he, ru; plain wording; mirror keys exactly).
- [ ] **Step 4: Run** `pnpm run check-cards && pnpm run check-locals && pnpm run build`. Expected: PASS (`check-locals` includes the blocked-word scan of the new `he` strings).
- [ ] **Step 5: Commit** `feat: capture note cards, deep links and ephemeral wrappers`.

### Task 4: `GroupListingService` and `ls_` buttons

**Files:**
- Create: `src/services/groupListingService.ts`
- Modify: `src/controllers/botController.ts` (construct the service, dispatch `"listing"`, and call `handleEdit` from the `edited_message` handler that slice 0 registered)
- Modify: `src/tests/checkFlows.ts`

**Interfaces:**
- Consumes: Task 2 repositories, Task 3 cards/links/`ephemeralNotes`, `classify`, `normalize`, `textHash`, `findBlockedWord`, `userRepository.findByUserId`, `localeService`.
- Produces `export type AddResult = { kind: "added"; listing: IListing } | { kind: "already"; listing: IListing | null } | { kind: "gone" }`.
- Produces `class GroupListingService`, `constructor(api: Api, config: BotConfig)`:
  - `addToMarket(captureId: string, fields: { title: string; price: string; location?: string }, now?: Date): Promise<AddResult>`. Atomically `transition(captureId, ["classified","asked"], "added")`; `null` → look the capture up: `added` with a `listingId` → `{kind:"already"}`, missing → `{kind:"gone"}`, `declined`/`ignored` → `{kind:"gone"}`. Then `countBySeller(senderId)` (kept as `firstForSeller`), `listingRepository.createFromCapture(…)` with `priceValue = priceValueOf(price)`, `text = normalize(capture.text)`, `textHash = textHash(capture.text)`, `isBundle = capture.parsed.isBundle`, and `setListing`; when the capture has a `note`, it is copied to `listing.note` (`ephemeralMessageId`, `sentAt`) so later presses and syncs find the note. If creation throws, `transition(captureId, ["added"], "asked")` and rethrow. When `firstForSeller`, `notifyNewSeller(listing)`.
  - `priceValueOf(price: string): number | undefined` (exported, pure): strips commas, takes the first `\d+(\.\d+)?`.
  - `notifyNewSeller(listing: IListing): Promise<void>`: no-op when `moderationGroupId` is falsy. Sends to `moderationGroupId` (thread `moderationTopicId` unless it is 1) text `captureModCard` with `name`, title/price and the group link (`resolveGroupLink`), `reply_markup` one button `{ text: captureModTakeDown, callback_data: "td_" + listing._id }`, using `config.lang`. Failures are logged `[ERROR - GroupListingService.notifyNewSeller]` and swallowed.
  - `handleListingCallback(query: CallbackQuery, arg: string, now?: Date): Promise<void>`: always answers the callback. Order: parse (`null` → toast `staleButton`); load the listing (`null` → `postNotFound`); `String(query.from.id) !== listing.sellerId` → toast `notYourButton`, nothing else; `listing.source !== "group"` → toast `staleButton` (bot listings use `sold_`/`bump_`; **Remove never works on a bot listing**); status not `live`/`expired` → toast `listingEnded` and show the ended state (below). Otherwise `s` → `endListing(…, "sold", "seller")`, `f` → `refresh(id, now)`, `r` → `endListing(…, "removed", "seller")`; a `null` result (lost race) counts as ended. Then `syncNote(updated)` and, for surface `c`, `editMessageText` of `query.message` (private chat, normal message) with the matching card; for surface `l`, re-render the `/myposts` section (Task 8's `renderGroupSection`; until Task 8 lands, edit with the ended/management card). Toasts: `listingSoldToast`, `listingRefreshedToast`, `listingRemovedToast`.
  - `syncNote(listing: IListing): Promise<void>`: when `listing.note` exists, `editNote` it (chat `listing.chatId`, receiver `Number(listing.sellerId)`) to the management card (surface `n`) for `live`, otherwise `buildEndedCard`. Best effort. The id used is `listing.note.ephemeralMessageId`; `query.message` is never read for a note.
  - `refreshFromRepost(listing: IListing, capture: ICapture, now: Date): Promise<IListing | null>` = `refresh(listing._id, now, capture.messageIds)`.
  - `handleEdit(msg: Message): Promise<void>` (never throws, logs `[ERROR - GroupListingService.handleEdit]`): `findLiveByMessage(chat.id, message_id)`; none → return. `text = msg.text ?? msg.caption ?? ""`. `findBlockedWord(text)` → `endListing(…, "removed", "system")` then `syncNote`. Else `classify(text, listing.media.length > 0)` and `applyEdit` with `text: normalize(text)`, `textHash`, `isBundle`, and `title`, `price`, `priceValue`, `location` only where parsed.
- Wiring: `botController.dispatchCallback`: `route.action === "listing"` → `groupListings.handleListingCallback(query, route.arg)`. The `edited_message` handler calls `captureService.handleEdit(msg)` then `groupListings.handleEdit(msg)`, regardless of `captureMode`.

- [ ] **Step 1: Write failing flow checks** in `checkFlows.ts` (new section "slice 2: listings"; the group is `APPROVED_GROUP`, `cfg.approvedTopicId = 1`, `cfg.captureMode = "optin"`). Seed with `captureRepository.insertClassified` then `addToMarket`:
  - `addToMarket creates a group listing`: result `added`; listing has `source:"group"`, `origin:"capture"`, `status:"live"`, `sellerId` = the capture's sender, `messageIds` = the capture's; the capture is `added` with `listingId`.
  - `first listing sends one take-down card`: exactly one `sendMessage` to `MOD_GROUP` whose keyboard is one button with `callback_data === "td_" + listingId`; a second capture for the same seller → no new message to `MOD_GROUP`.
  - `double Add is one listing`: `Promise.all([addToMarket(id,…), addToMarket(id,…)])` → one `added` and one `already`; `Listing.countDocuments({sellerId}) === 1`.
  - `foreign press refused`: user B presses `ls_${id}_s_n` on A's listing → `answerCallbackQuery.text === T("notYourButton")`, listing still `live`, no `editEphemeralMessageText`.
  - `Sold from the note`: A presses `ls_${id}_s_n` → listing `sold`, `endedBy:"seller"`; `editEphemeralMessageText` with `ephemeral_message_id` = the stored `listing.note` id, `receiver_user_id` = A, text starting `listingSoldNote` text for the title and `inline_keyboard: []`.
  - `press on an ended listing edits the note`: a second press `ls_${id}_f_n` → toast `T("listingEnded")`, status stays `sold`, the note is edited to the ended text, no throw.
  - `Refresh`: `ls_${id}_f_n` on a live listing → `refreshedAt` newer, the note re-edited with the management card (3 buttons plus the URL button).
  - `Remove`: `ls_${id}_r_n` → `removed`, `title` and `text` unset; **`remove never touches the group message`**: no `deleteMessage`, `editMessageText` or `sendMessage` to `APPROVED_GROUP` in `h.calls` (only `editEphemeralMessageText`).
  - `Remove refused on a bot listing`: a `source:"bot"` listing owned by A, press `ls_${id}_r_c` → toast `staleButton`, status unchanged. Same for `_s_c` (Sold on bot goes through `sold_`).
  - `press without query.message`: `pressButton(data, { noMessage: true })` for Sold on surface `n` still ends the listing and edits the note from Mongo.
  - `edit updates the price`: an `edited_message` in the sale topic for one of the listing's `messageIds`, caption `גלוק 17 למכירה\nבמצב מעולה\n1,100₪` → `price` `"1,100₪"`, `priceValue` 1100. An edit to a message not in any listing changes nothing.
  - `edit adding a blocked word removes the listing`: an edit whose text contains `נשק` → listing `removed`, `endedBy:"system"`, `title` unset, never `taken_down`.
- [ ] **Step 2: Run** `MONGO_URI=... pnpm run check-flows`. Expected: FAIL.
- [ ] **Step 3: Implement** the service and wiring.
- [ ] **Step 4: Run** `MONGO_URI=... pnpm run check-flows && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: group listings with Sold, Refresh, Remove and edit sync`.

### Task 5: The note send path

**Files:**
- Create: `src/services/captureNoteService.ts`
- Modify: `src/services/shadowService.ts`, `src/bot.ts`, `src/controllers/botController.ts`
- Modify: `src/tests/checkFlows.ts`

**Interfaces:**
- Produces in `shadowService.ts`: `interface ClassifiedEvent { capture: ICapture; result: ClassifyResult; mergeWith?: string }`; `type OnClassified = (event: ClassifiedEvent, now: Date) => Promise<void>`. `processOneClosed(config, now, onClassified?: OnClassified)` calls it after `saveClassification` inside its own `try/catch` (`[ERROR - shadow:onClassified]`), and `tick(config, now, onClassified?: OnClassified)` passes it through. Both parameters are optional, so slice 0's checks are unchanged.
- Produces `class CaptureNoteService`, `constructor(api: Api, config: BotConfig, groupListings: GroupListingService)`:
  - `onClassified(event: ClassifiedEvent, now: Date): Promise<void>` (never throws). Decision order: not `captureMode === "optin"` or tier not `strict`/`ask` → return. `mergeWith` set → load the listing; a `group` listing of the same seller → `refreshFromRepost`, capture `transition(["classified"], "ignored")` + `setListing`, and `sendRefreshNote` only when the member's `askMode !== "never"` and the cap allows; any other listing → `transition(["classified"], "ignored")`, silent. Else `askMode === "never"` → `ignored`. Else `memberRepository.hasDeclined(senderId, textHash(capture.text ?? ""), now-30d)` → `ignored`. Else `countNotesSince(senderId, now-24h) >= 3` → return (capture stays `classified`). Else `sendAskNote`.
  - `sendAskNote(capture: ICapture, parsed: Parsed, now: Date): Promise<boolean>` (no mode check; `/test` uses it): `transition(["classified"], "asked")` (null → `false`); builds `buildAskNote` in the seller's locale (`users` doc if any, else `config.lang`); `sendNote`; on `null`, `transition(["asked"], "classified")` and return `false`; on success `captureRepository.setNote(…, kind:"ask")`, `memberRepository.markNote`, return `true`.
  - `sendRefreshNote(listing: IListing, capture: ICapture, now: Date): Promise<boolean>`: `buildManagementCard(…, {surface:"n", refreshed:true})`, `sendNote`; on success `setNote` on the capture (`kind:"refresh"`) and the listing, then best-effort `deleteNote` of the listing's previous note. On failure: log and return `false` (the listing stays refreshed).
- Wiring: `BotController` gets `readonly groupListings` and `readonly captureNotes`; `bot.ts` passes `(event, now) => controller.captureNotes.onClassified(event, now)` as the third argument of `tick` in the captures job.

- [ ] **Step 1: Write failing flow checks.** Helper `post(h, user, text, {photo})` sends a sale-topic message (`chatId: APPROVED_GROUP`, `chatType: "supergroup"`) and `closeAndNote(ctrl)` calls `tick(cfg, new Date(Date.now() + 31_000), (e, n) => ctrl.captureNotes.onClassified(e, n))`. Texts are hand-written: `SALE1 = "גלוק 17 למכירה\nבמצב מעולה\n1,300₪ מרכז"`, `SALE2 = "וסט טקטי למכירה 250₪ צפון"`, `SALE3 = "כוונת אדומה למכירה 300₪"`, `SALE4 = "אוזניות תקשורת למכירה 400₪ דרום"`, `BARE = "1300 מרכז"`.
  - `strict post gets a note`: after `post(SALE1, photo)` and a tick, exactly one `sendMessage` with `ephemeral_message_parameters.receiver_user_id === user`, `chat_id === APPROVED_GROUP`, **no `message_thread_id`**, `reply_markup` callbacks `[mk_${capId}_a, mk_${capId}_n, mk_${capId}_x]`; the capture is `asked` and `note.ephemeralMessageId` equals the id the harness returned (5000-series).
  - `shadow mode sends nothing`: same flow with `cfg.captureMode = "shadow"` → zero `sendMessage`, capture `classified`, one `shadow_log` row.
  - `topic 73 note is threaded`: with `cfg.approvedTopicId = 73` and the message in thread 73, the note has `message_thread_id === 73`; reset to 1 afterwards.
  - `incomplete post gets the deep link`: `post(BARE, photo)` → the first button has `url === "https://t.me/JSTS_testing_bot?start=c_" + capId` and no `callback_data`.
  - `wtb gets no note`: `"מחפש גלוק 17 עד 800₪"` → zero sends.
  - `askMode never is silent`: `setAskMode(user,"never")`, then a strict post → zero sends, capture `ignored`.
  - `3 notes a day cap`: four different strict posts from one user, each followed by a tick → exactly 3 ephemeral sends; the fourth capture is `classified`.
  - `declined text is not asked again`: `declined` memory seeded with `recordDecline(user, textHash(SALE1), now)`; posting `SALE1` → zero sends, capture `ignored`. A different text from the same user is asked.
  - `repost refreshes, no question`: the seller has a live `group` listing whose `textHash` is that of `SALE1`; posting `SALE1` again → no ask note; listing `refreshedAt` advanced, `messageIds` = the new message; one ephemeral send whose first row is `[ls_${lid}_s_n, ls_${lid}_f_n, ls_${lid}_r_n]` and whose text starts with the `listingRefreshedCard` text; the old note is `deleteEphemeralMessage`d.
  - `two reposts leave one card`: repost twice in separate windows → two refreshes, `deleteEphemeralMessage` called once with the first repost's note id, and `listing.note.ephemeralMessageId` is the second's.
  - `repost of a bot listing is silent`: a `source:"bot"` listing with the same hash → zero sends, capture `ignored`.
  - `refresh note respects askMode never`: refresh happens, zero sends.
  - `note send failure leaves capture classified`: `createHarness({ responses: { sendMessage: (p) => p.ephemeral_message_parameters ? { ok: false, error_code: 403, description: "Forbidden" } : undefined } })`-style override (the ephemeral call fails) → capture `classified` with no `note`, nothing thrown, and a second tick sends nothing more.
  - `missing ephemeral id counts as failure`: the response lacks `ephemeral_message_id` → capture back to `classified`.
- [ ] **Step 2: Run** `MONGO_URI=... pnpm run check-flows`. Expected: FAIL.
- [ ] **Step 3: Implement** the service, the `shadowService` hook and the wiring. The `captures` sweeper job keeps its 10 s period.
- [ ] **Step 4: Run** `MONGO_URI=... pnpm run check-market && MONGO_URI=... pnpm run check-flows && pnpm run build`. Expected: PASS (slice 0's `check-market` still green: the hook is optional).
- [ ] **Step 5: Commit** `feat: send opt-in capture notes and refresh reposts`.

### Task 6: Note buttons (`mk_`)

**Files:**
- Modify: `src/services/captureNoteService.ts`, `src/controllers/botController.ts`
- Modify: `src/tests/checkFlows.ts`

**Interfaces:**
- Produces `CaptureNoteService.handleCallback(query: CallbackQuery, arg: string, now?: Date): Promise<void>`; always answers the callback. Order: `parseCaptureArg(arg)` (`null` → toast `staleButton`); `captureRepository.findById` (`null` → toast `staleButton`, nothing else: the TTL case); `String(query.from.id) !== capture.senderId` → toast `notYourButton`, nothing else. By action:
  - `a` (Add): guard that `capture.parsed` has a title and a price (otherwise toast `staleButton`; this can only come from a forged button). `groupListings.addToMarket(captureId, { title, price, location })`; `added` → `editNote` the capture's note (`capture.note.ephemeralMessageId`) to the management card (`listing.note` was set by `addToMarket`), toast `captureAddedToast`; `already` → re-edit the same card, toast `captureAlreadyAdded`; `gone` → toast `staleButton`.
  - `n` (Not now): `transition(["asked"], "declined")` (null → toast `staleButton`), `memberRepository.recordDecline(senderId, textHash(capture.text ?? ""), now)`, `deleteNote`.
  - `x` (Don't ask again): `memberRepository.setAskMode(senderId, "never", now)`, `recordDecline`, `transition(["asked"], "declined")`, `editNote` to `buildNeverNote`.
  - Edit/delete failures (the note already vanished) are logged and never change the outcome.
- `route.action === "capture"` in `dispatchCallback`: an `arg` starting with `set_` goes to `myPostsService.handleAskToggle` (Task 8); anything else to `captureNotes.handleCallback`.

- [ ] **Step 1: Write failing flow checks** (each starts from a seeded `asked` capture with a stored note, via `sendAskNote` or `insertClassified` + `setNote`):
  - `Add creates a listing and edits the note`: A presses `mk_${id}_a` → one `group` listing, capture `added`; `editEphemeralMessageText` with `chat_id === APPROVED_GROUP`, `receiver_user_id === A`, `ephemeral_message_id` = stored id, text containing the title, keyboard `[ls_.._s_n, ls_.._f_n, ls_.._r_n]` and a URL button `https://t.me/JSTS_testing_bot?start=l_${listingId}`; `answerCallbackQuery.text === T("captureAddedToast")`; `listing.note.ephemeralMessageId` is set.
  - `Add posts nothing public`: no `sendMessage`/`sendRichMessage` to `APPROVED_GROUP` anywhere in `h.calls`.
  - `double Add is one listing`: two presses → `Listing.countDocuments === 1`; the second toast is `captureAlreadyAdded`.
  - `Not now`: capture `declined`, `deleteEphemeralMessage` with the stored id, no listing, `members.declined` has `textHash(text)`; re-posting the same text → silent (covered in Task 5).
  - `Don't ask again`: `members.askMode === "never"`, `editEphemeralMessageText` text equals `T("captureNeverNote")` with a single URL button `https://t.me/JSTS_testing_bot`; the next sale post from A produces no send.
  - `foreign user's press refused`: B presses `mk_${A's capture}_a` → toast `T("notYourButton")`, capture still `asked`, no listing, no edit.
  - `press after capture TTL`: delete the capture row, then press Add → toast `T("staleButton")`, no listing, no throw.
  - `press without query.message`: `pressButton(..., { noMessage: true })` for Add works (the note id comes from the capture).
  - `Add when the note edit fails`: `editEphemeralMessageText` answers a 400 → the listing is still created, the toast still `captureAddedToast`.
  - `forged Add on an incomplete capture`: a capture with no title → toast `T("staleButton")`, no listing, state unchanged.
- [ ] **Step 2: Run** `MONGO_URI=... pnpm run check-flows`. Expected: FAIL.
- [ ] **Step 3: Implement** `handleCallback` and the route.
- [ ] **Step 4: Run** `MONGO_URI=... pnpm run check-flows && pnpm run check-callbacks && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: Add, Not now and Don't ask again on capture notes`.

### Task 7: Deep links `c_` and `l_`

**Files:**
- Modify: `src/controllers/botController.ts` (`HandleStart`, the `start` route), `src/services/wizardService.ts`, `src/services/myPostsService.ts`
- Modify: `src/tests/checkFlows.ts`, `src/tests/checkRoutes.ts`

**Interfaces:**
- `HandleStart(msg: Message, args = ""): Promise<void>`; the `start` route passes `args`. `parseStartPayload(args)`: `null` → the greeting (today's behaviour, unchanged); `{kind:"c"}` → `wizardService.startFromCapture(msg, id)`; `{kind:"l"}` → `myPostsService.showListingCard(msg, id)`. (Slices 4–6 add `s_`, `sell`, `k_` here.)
- `WizardService`, `constructor(api, config, inputService, postService, groupListings: GroupListingService)` (update every construction site):
  - `startFromCapture(msg: Message, captureId: string): Promise<boolean>`: capture missing, `senderId !== String(msg.from.id)` (a foreign id is indistinguishable from an expired one) or state not `classified`/`asked` → `captureExpired`; `added` → `captureAlreadyAdded`; a live (non-expired) draft exists → `captureDraftBusy` and nothing is overwritten. Otherwise: `step` = `title` if `parsed.title` is missing, else `price` if `parsed.price` is missing, else `confirm`; send that step's prompt (the preview when `confirm`) the way `begin` does, then `draftRepository.startFromCapture` with `title`, `description`, `price`, `location` from `parsed` and `media` from the capture.
  - In `handleMessage`, for a draft with `captureId`, the next step after `title` is `price` when `draft.price` is empty, otherwise `confirm`; after `price` it is `confirm`. The `confirm` preview is built from the draft with the just-typed answer applied. Description, location and media steps are never visited and `minimumPhotos` is not applied. Drafts without `captureId` behave exactly as before.
  - In `createPost`: a taken draft with `captureId` goes to `groupListings.addToMarket(captureId, { title, price, location })` instead of `postRepository.createPost`. `added` → `capturePublished` plus the DM management card (`buildManagementCard`, surface `c`), and the capture's note (if any) is synced; `already` → `captureAlreadyAdded`; `gone` → `captureExpired`. No `posts` row and no moderation message for a bot post.
- `MyPostsService`, `constructor(api, config, postService, groupListings)`:
  - `showListingCard(msg: Message, listingId: string): Promise<void>`: unknown id or `sellerId !== String(msg.from.id)` → `postNotFound`. `group` listing → `buildManagementCard` (surface `c`) when `live`/`expired`, otherwise `buildEndedCard`. `bot` listing → the post's existing card (make `sendApprovedPostDetail` public) with the `sold_`/`bump_` buttons when the post is `approved`; no Remove ever.

- [ ] **Step 1: Write failing checks.**
  `checkFlows.ts`:
  - `incomplete note → deep link → prefilled wizard → group listing`: post `BARE` with a photo, tick, note has the `c_` URL. User sends `/start c_${capId}` in private → a draft with `captureId`, `quick:true`, `step:"title"`, `price` equal to the parsed price string, `location:"מרכז"`, `media.length === 1`; the prompt is the title prompt. Sends `"אופניים"` → step `confirm` (not `description`), one `sendRichMessage` preview. Presses the `confirm_…` button → one `group` listing with `title:"אופניים"`, capture `added`, `Post.countDocuments({userId}) === 0`, the only message to `MOD_GROUP` is a card whose keyboard has `td_`, no `approve_` button, and the user gets the `capturePublished` text.
  - `complete capture via deep link goes straight to the preview`: a capture with title and price → `/start c_…` → draft at `confirm` and a preview.
  - `c_ expired`: a deleted capture, an unknown 24-hex id and another user's capture all answer `T("captureExpired")` and create no draft.
  - `c_ with a live draft`: user has a `/newpost` draft → `T("captureDraftBusy")`, the old draft untouched.
  - `capture draft honours the blocked word`: typing `"לנשק"` as the title stops at the preview and asks for the title again (slice 1's preview check, reached through the same path). If this fails, the capture path bypasses slice 1's check: route it through the same function.
  - `normal wizard unchanged`: the existing full-wizard assertions still pass (they run before this section).
  - `l_ opens for a fresh user`: a user id with no `users` row sends `/start l_${id}` for their own group listing → a `users` row now exists, the reply carries `[ls_.._s_c, ls_.._f_c, ls_.._r_c]`, and the text is in the default locale.
  - `l_ foreign user refused`: another user → `T("postNotFound")`, no buttons.
  - `l_ on a bot listing`: shows the post card with `sold_`/`bump_`, no `ls_` and no Remove.
  - `DM card actions`: pressing `ls_${id}_f_c` edits the card message (`editMessageText`) and the group note; `ls_${id}_s_c` marks sold and removes the keyboard.
  `checkRoutes.ts`: `/start garbage` and `/start c_xyz` answer the greeting (same text as plain `/start`).
- [ ] **Step 2: Run** `MONGO_URI=... pnpm run check-flows && MONGO_URI=... pnpm run check-routes`. Expected: FAIL.
- [ ] **Step 3: Implement** the three pieces.
- [ ] **Step 4: Run** the same commands plus `pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: start=c_ prefilled drafts and start=l_ listing cards`.

### Task 8: `/myposts` with group listings and the settings row

**Files:**
- Modify: `src/services/myPostsService.ts`, `src/services/groupListingService.ts`, `src/controllers/botController.ts`
- Modify: `src/tests/checkFlows.ts`

**Interfaces:**
- `GroupListingService.renderGroupSection(userId: string, locale: string): Promise<{ card: Card; hasListings: boolean } | null>`: returns `null` when the user has no group listing and `captureMode !== "optin"`. Otherwise HTML text: `myPostsGroupTitle`, then for each live/expired listing (newest first, at most 15; if more, a last line `+N`) a numbered line `N. <a href="{group link}">{escaped title}</a> · {escaped price}`, then, when any ended listing exists, one line `myPostsGroupEnded` with `n`. Keyboard: for each listed row `[🤝 N (ls_.._s_l), 🔄 N (ls_.._f_l), 🗑 N (ls_.._r_l)]`, then the settings row: askMode `ask` → one button `myPostsAskStopButton` with `mk_set_never` (and the line `myPostsAskOn` in the text); `never` → `myPostsAskResumeButton` with `mk_set_ask` (`myPostsAskOff`). Titles come from `escapeHtml`.
- `MyPostsService.showPosts`: bot posts rendered exactly as today. After them, send the section (`parse_mode: "HTML"`, `link_preview_options: { is_disabled: true }`) when non-null. No posts and no listings: with a section, send `myPostsEmpty` carrying the section's keyboard; without a section, today's empty message. `MyPostsService.handleAskToggle(query: CallbackQuery, arg: "set_ask" | "set_never" | string, now?: Date): Promise<void>`: `memberRepository.setAskMode(String(query.from.id), …)`, answers the callback, re-renders the pressed message (`editMessageText` with the fresh section).
- `GroupListingService.handleListingCallback` surface `l` re-renders the section.

- [ ] **Step 1: Write failing flow checks.**
  - `myposts: bot posts only, optin off`: with `captureMode = "shadow"` and one approved bot post, the calls are byte-for-byte the pre-slice set (the HTML summary, then the approved rich message) and no third message.
  - `myposts: both sources`: `captureMode = "optin"`, one approved bot post, two live group listings and one `sold` → first the summary (contains `myPostsTitle` text), then the approved rich message with `sold_`/`bump_`, then the section: text has two numbered lines with `<a href=` and one `myPostsGroupEnded` line (`n` 1); the keyboard rows are `[ls_A_s_l, ls_A_f_l, ls_A_r_l]`, `[ls_B_…]`, then `[mk_set_never]`.
  - `section row buttons act`: pressing `ls_${A}_s_l` sold-marks A, the pressed message is edited (`editMessageText`) and A's line disappears from the live list; the group note is synced.
  - `settings toggle`: pressing `mk_set_never` → `members.askMode === "never"`, the message is edited and now carries `mk_set_ask`; pressing it again restores `ask`.
  - `no posts, optin on`: a new user gets `myPostsEmpty` with the `mk_set_never` keyboard; with `captureMode = "shadow"` just the empty text.
  - `html is escaped`: a listing titled `a<b>&c` renders `a&lt;b&gt;&amp;c`.
- [ ] **Step 2: Run** `MONGO_URI=... pnpm run check-flows`. Expected: FAIL.
- [ ] **Step 3: Implement** `renderGroupSection`, `showPosts` changes and `handleAskToggle`; route `mk_set_*` in `dispatchCallback`.
- [ ] **Step 4: Run** `MONGO_URI=... pnpm run check-flows && pnpm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: /myposts lists group listings and capture-note settings`.

### Task 9: Opt-in rate in `/stats`

**Files:**
- Modify: `src/services/shadowAdminService.ts` (slice 0), `src/tests/checkRoutes.ts`

**Interfaces:**
- Consumes `captureRepository.noteStats(since)`. `handleStats` appends, for each of the 7-day and 30-day columns, a line `statsOptin` with `notes`, `added` and `rate` (`added / notes` as a rounded integer percent, or `—` when `notes` is 0). The line appears only when `captureMode === "optin"` or `notes > 0`.

- [ ] **Step 1: Write the failing check** in `checkRoutes.ts` (slice 0's `/stats` MOD test as a base): seed two `ask` captures with notes in the last day, one `added`; `/stats` from a MOD contains the `statsOptin` text with `notes` 2, `added` 1, `rate` 50%. With `captureMode = "shadow"` and no notes the line is absent.
- [ ] **Step 2: Run** `MONGO_URI=... pnpm run check-routes`. Expected: FAIL.
- [ ] **Step 3: Implement** the line.
- [ ] **Step 4: Run** `pnpm run check-locals && MONGO_URI=... pnpm run check-routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: opt-in rate in /stats`.

### Task 10: `/test` case, synthetic run, docs, release prep

**Files:**
- Modify: `src/tests/testCases.ts`
- Create: `src/tests/syntheticOptin.ts` (run manually, not part of `pnpm test`)
- Modify: `docs/README.md` (Features, deep links), `docs/CHANGELOG.md`, `Agents.md` (structure: new services, `deepLinks`, `ephemeralNotes`, `listingCards`; Session Management note on `captureId`/`quick` drafts and `members.declined`; the callback prefixes; testing table row for `check-cards`; the AGENTS note that `/config captureMode` accepts `optin`), `config.json.example` (unchanged: stays `shadow`), `package.json` (`check-cards` already added in Task 3)

**Interfaces:**
- `/test` case `capture_note`, label `"🛒 Send me a capture note"`: builds a `GroupListingService` and `CaptureNoteService` from the passed `api`/`config`, inserts a fixture capture with `insertClassified` (`chatId: config.approvedGroupId`, `senderId: String(msg.from.id)`, `messageIds: [1]`, text `"גלוק 17 למכירה\nבמצב מעולה\n1,300₪ מרכז"`, parsed title `"גלוק 17"`, price `"1,300₪"`, location `"מרכז"`), calls `sendAskNote`, and DMs the presser whether the note was sent and in which group and topic. Fixture only: pressing Add makes a listing that points at message 1, which is fine on the test bot.
- `syntheticOptin.ts`: refuses unless `BOT_TOKEN` starts with `9299714864:` (the test bot) and `MONGO_URI` points at a throwaway database. Builds a `Bot` with the real token and a fetch wrapper that fakes only `answerCallbackQuery`; every other method (including `sendMessage` with `ephemeral_message_parameters`, `editEphemeralMessageText`, `deleteEphemeralMessage`) goes to Telegram for real. Config: `captureMode:"optin"`, `approvedGroupId:-1002445943058`, `approvedTopicId:73`, `moderationGroupId:-1002474192098`, `moderationTopicId:15`. Steps, each printing `[OK]` or exiting non-zero: (1) feed `bot.handleUpdate` a fixture sale post (photo file id from `TEST_MEDIA`, Hebrew caption) "from" user 278683632 in the user-facing test group, thread 73; (2) `tick` 31 s ahead with the hook → the capture is `asked` and `note.ephemeralMessageId` is a number (the real note is on the owner's phone); (3) feed a callback `mk_<id>_a` from 278683632 → `editEphemeralMessageText` succeeds (no exception logged as `[WARN - ephemeralNotes.edit]`), a listing exists, a take-down card reached topic 15; (4) feed `ls_<listingId>_r_n` → listing `removed`, note edited; (5) clean up: `deleteNote`, delete the moderation card, delete the Mongo rows. Prints the Telegram `description` of any failed call so a wrong assumption about the API is visible.

- [ ] **Step 1: Add the `/test` case** and run `pnpm run build`. Expected: compiles.
- [ ] **Step 2: Write `syntheticOptin.ts`**, check the token prefix without printing the token, then run `MONGO_URI=... pnpm exec ts-node src/tests/syntheticOptin.ts`. Expected: steps 1–5 all `[OK]`. Record any difference between the real API and the harness (for example the `ephemeral_message_id` field name, or an edit that needs `reply_markup`) and fix the code, not the check.
- [ ] **Step 3: Update docs** as listed. CHANGELOG "Unreleased": opt-in capture notes, `start=c_`/`start=l_`, `/myposts` group listings, `captureMode: optin`.
- [ ] **Step 4: Full verification:** `pnpm run lint && pnpm run build && MONGO_URI=... pnpm test`. Expected: exit 0, "Tests passed", no `[SKIP]`.
- [ ] **Step 5: Commit, push, open the PR** (base: the slice 1 branch, or master once slice 1 has merged). PR body: scope, review focus results, test output, the synthetic run output, the decisions list from the top of this plan, and the owner gates below. Don't merge.

**Owner gates (in the PR body, not tasks):**
1. On the test bot, press **Add** once from the real note (the harness fakes the callback, so this is the first real press): the log line from `GroupListingService`/`CaptureNoteService` should show the card edited. If the real callback carries a `message` with `ephemeral_message_id`, note it for slice 3 (it would let a press edit the exact note instead of `listing.note`).
2. **A second account** (not the poster, not an admin) in the test group confirms that other members do not see the note. This is still unverified (#104); it must pass before `captureMode: optin` is set in prod.
3. Prod rollout order: deploy with `captureMode: shadow` (no behaviour change), then `/config captureMode optin` only on the owner's go-ahead. `/config captureMode shadow` is the kill switch: notes stop at once, existing listings stay manageable.
