# Changelog

All notable changes to this project will be documented in this file.


## Version History
Unreleased (slice 5) - One-message listing and the Beit Dagan meeting point (#104).
  - Added:
    - **`quickListing`** (boolean, default off; `config.json.example` ships `false`). With it on, a photo, video or album with a caption sent in DM, with no draft in progress, starts a quick draft. The caption is parsed by the classifier; missing title, price or `minimumPhotos` go to that wizard step, otherwise the preview comes straight away. Album items are collected into one draft and the preview goes out 1.5 s after the last item (an in-memory timer holding only the user id: a restart loses only the send, and `/newpost` then Continue resends). A caption-less album is dropped silently. A `wtb` caption gets no draft: with `buyerMatches: "on"` it gets the list of matches, a hint to use `/alerts <query>` and a "Selling this? Send /newpost" line; otherwise one line pointing to the group and `/newpost`. A first line over 60 characters is kept whole in the description; a bare number under 100 stays in the title, not the price. Blocked words and moderation work as before.
    - **Field-edit buttons and the Beit Dagan toggle** on every preview, and the toggle on the location step (with `quickListing` on). Buttons: `draft_edit_title_<userId>`, `draft_edit_price_<userId>`, `draft_edit_location_<userId>`, `draft_meetup_<userId>`, all frozen and pinned in `check-callbacks`.
    - **`/start sell`** (with `quickListing` on): a live draft gets Continue / Start over, otherwise a hint on how to post in one message.
    - **Meeting point.** Optional `meetup` flag on listings, drafts and posts. Display `📍 {location} · בית דגן`; a location of בית דגן counts as a meetup. On a post the words of the meeting point in the location line link to `start=faq_1`, which opens FAQ node 1 (works whatever `quickListing` says); the link survives a Sold edit. Buyer notes, alert DMs and DM match lists show the place and carry a button to that link when any listed listing is a meetup; with no meetup listing their text and keyboards are unchanged. New file `src/services/meetup.ts`.
    - **`/myposts` survives a photo Telegram refuses.** That post goes as plain text with its Sold and Bump buttons, and the next posts and the Relist section still go.
    - **A single photo with no caption** (with `quickListing` on, no draft) gets a one-line hint; an album item stays silent.
    - **Quick draft description** is only what the title, price and location left.
    - **FAQ messages** carry one line of invisible padding, so their buttons are wide.
    - Tests: new `src/tests/quickListingChecks.ts` (run from `check-flows`), plus coverage in `check-cards`, `check-buyer`, `check-callbacks` and `check-routes`.
  - Notes:
    - Data: additive only. New optional draft fields `quick`, `collecting`, `mediaGroupId`, `caption`, `meetup`; new optional `meetup` on posts and listings. After a rollback to 3.1.0 they are ignored and the `draft_edit_*` / `draft_meetup_*` buttons answer as stale.
    - The version is not bumped here; the owner picks the release order.

Unreleased - Numbered stale-check results.
  - Changed:
    - On a multi-item `/stalecheck` DM, each result line now starts with the item's number ("1 · Refreshed"). `lcItemResult` is a new locale string; a stale button's label must keep starting with `{i}`, which `check-routes` enforces.
Unreleased (slice 4) - Buyer matches and alerts (slice 4 of "the market", #104).
  - Added:
    - **Buyer notes.** With `buyerMatches: "on"`, a "wanted" message in the sale topic gets a private note to its author listing the live listings that match (or saying there are none), with an **Alert me** link into the bot (`?start=s_<captureId>`). A buyer gets at most one note per 6 hours.
    - **Saved searches and alerts.** The `s_` link saves the search. `/alerts <text>` also saves one, `/alerts` lists them (max 5 per buyer) with remove and renew buttons (`al_<searchId>_<d|r>`), and when the text is too thin the bot asks for one reply to fix it. The sweeper DMs a buyer when a new listing matches (25 per tick, each pair sent once, a 403, meaning the buyer blocked the bot, deletes all of that buyer's saved searches). A search holds the parsed query, never the original message. A renewal offer goes out a few days before expiry.
    - `buyerMatches` accepts `on` besides `off` and `shadow`. The code default stays `off` and `config.json.example` stays `shadow`; `/config buyerMatches shadow` is the kill switch.
    - `/label` also labels buyer matches as useful or not (`lb_<id>_<u|d|m>`), and `/stats` gained a buyer line.
    - Tests: `check-buyer` (new, in `pnpm test`, needs `MONGO_URI`), plus coverage in `check-callbacks`, `check-cards`, `check-routes`, `check-classifier` and `check-rich`. `/test` gained buyer cases. `src/tests/syntheticBuyer.ts` is manual (not in `pnpm test`), TEST bot and groups only.
  - Notes:
    - `s_` carries a capture id, and captures live 7 days, so an `s_` link stops working after 7 days. `/alerts <text>` has no such limit.
    - A listing `/stalecheck` just asked about does not alert until its seller confirms it; the confirm alerts once.
    - A "wanted" post the bot cannot search (no model name, only a ceiling (`עד 800`) or a phone number) gets no note.
    - Private notes are best effort: they reach only apps online when sent. The alert DMs are ordinary messages.
    - The `saved_searches` TTL deletes a search at 60 days in every mode, including `shadow` and `off`.
    - Data: additive only. New collections `saved_searches` and `alert_log`; new optional fields `shadow_log.matchLabel*`, `shadow_log.buyerNoteAt`, `members.lastBuyerNoteAt` and `listings.meetup`. Rolling back to 3.2.0 or 3.1.0 leaves them as harmless leftovers; `al_` buttons fall to the stale toast and `s_` links to the greeting.
    - Take the `mongodump` from `docs/BACKUP.md` first, before deploying. Deploys need the owner's go-ahead. The version is not bumped here; the owner picks the release order.

3.2.0 - Listing lifecycle (slice 3 of "the market", #104).
  - Added:
    - **Nudge.** With `nudges: true`, a listing not refreshed for 7 days gets a DM to its seller (Refresh and Sold; a group listing also gets Remove). A seller the bot cannot DM is held: the nudge arrives as a private note (with Manage) after their next sale-topic message. Held nudges need capture on (`captureMode` not `off`). Bump lifts `hold`, so it shrinks the `/stalecheck` count.
    - **Expiry.** A live listing not refreshed for 30 days expires. This runs whatever `nudges` says (legacy `hold` listings are skipped). An approved bot post stays `approved` when its listing expires; the group message is not touched.
    - **Relist.** `/myposts` shows the seller's expired bot listings with a Relist button. Callbacks `lc_<r|s|x>_<listingId>` (refresh/relist, sold, remove) are frozen. A seller can still never remove an approved bot post: it ends only by Sold, expiry or take-down.
    - **Trust line** on new group cards (sales count plus the date the seller started; nothing extra for a new seller).
    - **`/stalecheck`** (admin, DM only): asks the sellers of the legacy listings that are on hold whether each is still for sale (`sc_go` to send after a dry run, `sc_no` to cancel; the buttons in the seller's DM use `lc_`). `/stalecheck <userId ...>` limits it to those sellers. Unanswered listings expire 7 days after the DM, a blocked seller's expire at once.
    - Tests: `/test` gained "Age my test listing 7 days" / "30 days" and "Stale-check dry run (to me only)" (test bot only); `check-callbacks`, `check-cards` and `check-market` cover the new formats and flows; `src/tests/syntheticLifecycle.ts` (manual, TEST bot only, sends two real DMs to the owner).
    - **Take down and delete original post.** A group listing's take-down card has a second button (`tx_<listingId>_<d|y|n>`, moderators only) that also deletes the member's message and all its photos, after one confirm step that survives a restart. A double press acts once, the press is logged with the moderator, listing and message ids, and if Telegram refuses some deletions (48 h limit, missing right) the card says how many are left. The listing still ends and the seller is told as for a take-down. Bot listings keep the single button; a seller's Remove still never deletes anything.
  - Changed:
    - eslint 10.13.0 → 10.14.0, globals 17.13.0 → 17.14.0, mongoose 9.11.4 → 9.12.0 (mongodb driver 7.8). Removed the `node-telegram-bot-api@2.3.0` `minimumReleaseAgeExclude` from `pnpm-workspace.yaml` (now over 24 h old). TypeScript 7 stays out (blocked by `ts-node` and `typescript-eslint`).
  - Notes:
    - Data: additive only. `listings.nudgeHeld` and `listings.staleSentAt` are new optional fields; `posts` and `users` are unchanged. Rolling back to 3.1.0 is safe: the old image ignores the fields and the `lc_`/`sc_` buttons do nothing.
    - **Rollout order** (owner gates, nothing automatic): (1) deploy with `nudges: false`: legacy listings stay on hold and nothing is sent; expiry runs for non-hold listings. (2) Run `/stalecheck` on the test bot, read the dry run, finalize the text, then "Stale-check dry run (to me only)". (3) On prod, `/stalecheck <pilot ids>`, wait for answers, then `/stalecheck` for the rest. (4) `/config nudges true` only on the owner's go-ahead; at most 25 nudges go out per tick, so the first batch spreads over several ticks.
    - Do not deploy during a `/stalecheck` send. Before deploying, this read-only query should return 0: `db.listings.countDocuments({status:"live",hold:false,refreshedAt:{$lte:new Date(Date.now()-30*864e5)}})`.
    - Take the `mongodump` from `docs/BACKUP.md` first. Deploys need the owner's go-ahead.

3.1.0 - Opt-in capture notes (slice 2 of "the market", #104).
  - Added:
    - **Opt-in capture notes.** With `captureMode: "optin"`, a sale post in the sale topic gets a private note to its author (an ephemeral message only they see; nothing is posted publicly) with **Add** (`mk_<captureId>_a`), **Not now** and **Don't ask again**. Add makes a group listing pointing at the member's own message; a post missing a title or price offers a button into the bot instead. A repost of the same item (same text, or a near-identical text with the same title) refreshes the listing, which follows the newest repost (message, text, price, photos), and sends a short refresh note; a different item that reads alike gets its own note. Limits: 3 notes per seller per 24 h (ask and refresh notes both count), and a text a note was sent for is not asked again for 30 days, answered or not. A blocked word ends the capture silently.
    - **Group listings.** Sold, Refresh and Remove (`ls_<listingId>_<s|f|r>_<n|c|l>`) from the note, from a bot card or from `/myposts`; editing the member's message keeps the listing in step (a blocked word ends it). The member's message is never touched, and a seller can never remove an approved bot post (every `ls_` button is refused on one). A seller's first listing of any kind (no listing yet, neither an approved bot post nor a group listing) sends a **Take down** card (`td_`) to the moderation topic: group listings are post-moderated.
    - **Deep links.** `?start=c_<captureId>` opens a draft prefilled from a captured message (refused while another draft is open); `?start=l_<listingId>` opens a listing's management card.
    - `/myposts` lists group listings with Sold / Refresh / Remove and a stop/resume-asking toggle. `/stats` gained an opt-in line (notes, added, rate).
    - `captureMode` accepts `optin` besides `off` and `shadow`. `config.json.example` stays `shadow`; `/config captureMode shadow` is the kill switch (notes stop at once, existing listings stay manageable in every mode).
    - Tests: `check-cards` (new, in `pnpm test`), plus coverage in `check-callbacks`, `check-routes`, `check-flows` and `check-market`. `/test` gained "Send me a capture note" (test bot only). `src/tests/syntheticOptin.ts` (manual, TEST bot and groups only) sends one real note and one moderation card through the real controller and cleans both up.
  - Fixed:
    - The bot now always names the update types it polls for (`allowedUpdates`). Without the list, Telegram reuses the last one set for the token; on the test bot that dropped every button press.
    - A moderator take-down closes the seller's private note.
  - Notes:
    - Private notes are best effort: they reach only apps online when sent, silently in the background and not at all to a closed app (tested on Telegram Desktop 7.4 and Android 13.2.0). `/myposts` stays the durable path.
    - Data: additive only. `captures.note.kind`, `members.declined` (hashes of the texts a note was sent for, 30 days, 20 max) and `drafts.captureId` are new optional fields; `listings` gained nothing, `posts` and `users` are unchanged.
    - **Rollback caveat:** an older image's wizard would post a draft that has `captureId` as a bot post, so `/start c_` refuses to overwrite a live draft and nothing else creates capture drafts. After a rollback the `mk_` and `ls_` buttons do nothing (no route) and `/myposts` does not show group listings. Listings the members added stay in the database.
    - Take the `mongodump` from `docs/BACKUP.md` first, before deploying.
    - Deploys need the owner's go-ahead.
    - Deploy with `captureMode: shadow` (no behaviour change). Turn on `optin` only on the owner's go-ahead, and only after a second account (not the poster, not an admin) confirmed in the test group that other members do not see the note (#104).

3.0.0 - Trust-based moderation (slice 1 of "the market", #104).
  - Added:
    - **Trusted sellers publish at once.** A seller with an approved or sold bot post and no moderator take-down in the last 90 days is trusted: their new post goes straight to the sales group, and the moderation group gets a "Published (trusted seller)" card to review afterwards. Everyone else still goes through moderation. Captured group listings never grant trust.
    - **Take down.** Every published card (trusted or moderator-approved) carries a Take down button (`td_<listingId>`) when its listing exists. It is atomic (one press wins), removes the group message, marks the listing `taken_down` (the post stays `approved`), and tells the author. A taken-down post can't be bumped or marked sold, and a take-down revokes trust for 90 days. The effects are independent and best-effort, so one failure doesn't block the rest.
    - **Reject presets.** Rejecting shows four preset reasons as buttons (`rr_<postId>_<n>`); the moderator can instead reply to the prompt with their own reason. New prompts have no Skip button; Skip buttons on prompts sent before the upgrade keep working. The reject message to the author has a "Fix and resend" button and, when `rulesUrl` is set, a "Group rules" button.
    - **Blocked-word check at the preview.** A blocked word in the title, description, price or location stops the post before the preview, for everyone including trusted sellers (the hidden URL of a text link in the description counts too): the bot names the word and asks for that field again, then returns to the preview.
    - `/config rulesUrl` is now used (it was reserved in 2.1.0).
    - Seller-post `/test` cases (trusted and new sellers, synthetic preset reject) and `src/tests/syntheticModeration.ts` (manual, test bot and group only). The `/test` cases refuse to run outside the test bot.
  - Changed:
    - The author is told about a rejection exactly once, whichever way the reason arrives (preset, reply, Skip, or a double press): the notice goes through a new atomic claim (`claimRejectionNotice`). The reject itself keeps its atomic claim.
    - Marking a post sold now also ends its listing, so a moderator's Take down finds nothing to remove on a sold post.
    - The rule "every post passes moderation before the sales group" now reads: new sellers pass moderation; trusted sellers publish at once and are reviewed after (`Agents.md`).
    - `pnpm test` gained coverage of these flows in `check-flows`, `check-callbacks` (the `rr_` and `td_` formats are pinned and frozen), `check-claim`, `check-market` and `check-platform`. `check-locals` also fails if a `he` string contains a blocked word.
  - Notes:
    - Data: additive only. `posts` gains the optional `rejectionNotifiedAt` and `drafts` the optional `fixing`; no existing field changes.
    - **Rollback caveat:** the realistic rollback target is 2.1.0, and the 2.0.1 image also runs against the same database. Neither knows about take-down or the new buttons, so after a rollback:
      - Bump and Sold still work on a post a moderator took down (and it shows in `/myposts`).
      - `rr_` and `td_` buttons answer "expired"; a new reject prompt can only be resolved by a typed reply.
      - A typed reply after another moderator's preset can DM the author twice (2.1.0 has no once-only notice claim).
      - Trust revocation survives: the 2.1.0 reconcile leaves `taken_down` listings alone.
      If you roll back after take-downs, treat these as known.
    - Take the `mongodump` from `docs/BACKUP.md` first, before deploying.
    - Deploys need the owner's go-ahead.
    - `rulesUrl` (`https://t.me/airsoft_yad2/54833/115880`) is already set in prod by the owner; with it empty the rules button is hidden.
    - Security: Dependabot alert #21 (GHSA-g3hv-75wg-m249, minimatch globparts DoS). Dev-only (nodemon, eslint, typescript-eslint); production installs with `--prod` and was not affected. No newer nodemon, eslint or typescript-eslint depends on a patched minimatch, so `pnpm-workspace.yaml` now overrides `minimatch` to `^11.0.4`. Lint, build and tests are unchanged.

2.1.0 - Dependency update, and the market core in shadow mode (slice 0 of "the market", #104).
  - **Market core, shadow mode only: nothing is sent to the group or to any member.** `captureMode: "shadow"` records messages in the sale topic (`approvedTopicId`) into per-sender windows (90 s; closed after 30 s of quiet), classifies each as `strict`, `ask`, `wtb` or `none` with a pure Hebrew-aware classifier, and logs what automatic capture would have done. `buyerMatches: "shadow"` also logs up to 5 live listings a "wanted" message would match. Both keys accept only `off` or `shadow` in this slice. New keys `nudges` and `rulesUrl` are accepted by `/config` but unused until a later slice.
  - New `/label` (admin, private chat) shows a random would-list row with its link, tier and parsed price (as a number; no member text is stored), to mark it sale / not sale / skip. New `/stats` (moderator, private chat) shows the numbers behind the go/no-go on automatic capture: rows per tier, would-list and merge counts, label precision.
  - Blocked words: a message containing an entry of `src/config/blockedWords.json` is classified `none`.
  - Existing approved bot posts get a matching `listings` row at startup and then hourly (idempotent). Posts made before `LEGACY_CUTOFF` (2026-11-04, confirm at deploy) are legacy: held out of matching.
  - Data: **new, additive collections** `listings`, `captures` (7-day TTL), `shadow_log` (120-day TTL) and `members`. No existing collection or field changed, and rolling back to 2.0.1 leaves them as harmless leftovers.
  - Tests: `pnpm test` gained `check-config`, `check-classifier` and `check-market` (the last needs `MONGO_URI`); `check-callbacks` and `check-routes` cover the new buttons and commands. `/test` gained "Classify fixtures" and "Shadow: last 5 rows". `src/tests/syntheticCapture.ts` (manual, TEST bot and group only) feeds 20 messages through the real controller and checks the tiers.
  - The blocked-word list (`src/config/blockedWords.json`) is read from disk and re-read within about 60 s of a change, so the owner can edit it on the server with no rebuild or restart. `compose.prod.yaml` mounts a host folder (`./blocklist`) and points `BLOCKED_WORDS_PATH` into it, falling back to the built-in list when the file is missing; see the deploy note in `docs/README.md`. A bad edit keeps the last good list. `/config` now treats `constructor`, `toString` and other `Object.prototype` names as unknown keys.
  - Upgraded `node-telegram-bot-api` 2.2.0 → 2.3.0 (pinned exactly). No code changes were needed and nothing the user sees changes. Notable library changes: a graceful stop (`SIGINT`/`SIGTERM`) now confirms the update being handled, so a deploy no longer redelivers it; `bot.init()` calls `getMe()` once at startup. The bot's own command matcher is unchanged.
  - `pnpm-workspace.yaml` exempts `node-telegram-bot-api@2.3.0` from pnpm's `minimumReleaseAge` (the release was under 24 hours old). It can be removed after 2026-11-05. The Docker build now copies `pnpm-workspace.yaml` too, so image builds honour the same pnpm settings as CI.

2.0.1 - UX fixes found while testing 2.0.0.
  - `/lang`: picking a language removes the menu's buttons, so it can't keep switching (#97).
  - Sellers' formatting in the description (spoiler, bold, italic, links, ...) is kept and shown in the post. It is stored in a new optional `descriptionEntities` field (additive; posts without formatting are unchanged) (#98).
  - `/myposts`: Mark sold re-renders the post card as sold in place, and Bump leaves the card alone. Before, both replaced the card with the summary list (#99).

2.0.0 - Ported to node-telegram-bot-api 2.2.0, and conversations now survive restarts. Release 1 of the v2 migration (issue #84).
  - Upgraded `node-telegram-bot-api` 1.2.0 → 2.2.0 (pinned exactly). The bot is now a v2 middleware chain (`ensureUser`, session, global message handler, commands, callback router, dead-button catch-all), and services call the v2 `Api` with params objects. Every command, button, `callback_data` format and message the user sees is unchanged, except for the items below. Commands and buttons keep working on messages sent by earlier versions.
  - **Persistent flows.** Nothing a user or moderator is in the middle of lives in process memory any more, so a restart or deploy no longer loses it. The `/newPost` wizard is a step machine over a new `drafts` collection (one document per user: step, answers, media, expiry clock). The donation custom-amount prompt and the moderator's pending reject-reason prompt live in the v2 session, kept in a new `bot_sessions` collection (key `chat:user`, 3-day idle TTL; a prompt left unanswered longer than that is dropped). The in-memory session map, `isIdle` flags and the temporary listener bridge are gone.
  - **Behavior change:** `timeOut` now actually expires drafts. The key was read nowhere before (the README showed it struck through). It is minutes of inactivity, checked against the live value on every touch, so a `/config timeOut` change applies at once; `0` means never. Acting on an expired draft says so, and a startup sweep deletes drafts already past the limit. `config.json.example` ships `1440` (one day).
  - New `/cancel`: in a private chat it drops your `/newPost` draft; in the moderation group it forgets your pending reject-reason prompts.
  - `/newPost` with a draft in progress now asks Continue (the current prompt is sent again) or Start over (the draft is deleted), instead of silently starting a second wizard.
  - **Behavior change:** the reject-reason prompt is now a message the moderator REPLIES to, and it carries a ⏩ Skip button (v1 took the moderator's next message in the chat, which could be an unrelated one). Writing without replying gets a hint; another moderator pressing Skip gets "not your button". The author is told once a reason or Skip arrives; a prompt dropped by the session TTL leaves the post rejected and the author is not told. Moderator-facing text in the group uses the default `lang`.
  - **Behavior change:** commands are matched by an anchored, case-insensitive rule that ignores `/command@otherbot` and accepts `@ourbot`. A `/test` inside a URL or the middle of a sentence no longer fires a command.
  - Wizard and prompt buttons with no live flow behind them (confirm, cancel, done-media, skip, continue/start over) answer "This button has expired." and lose their keyboard, instead of doing nothing.
  - Clean shutdown on `SIGINT` and `SIGTERM` is now owned by the library's `run()`: polling stops and Mongo closes.
  - Data: two **new, additive collections**, `bot_sessions` and `drafts`. No existing collection or field changed (`posts` and `users` have no new fields), v1 ignores both, and rolling back to the previous release leaves them as harmless leftovers. `/activeUsers` and `/broadcastUsers` now read "users in the middle of a post" from `drafts`.
  - `/test` suite: "Broadcast Custom Message" was removed (it waited on a typed reply), and "Wizard draft status" was added to show your own draft (step, media count, age against `timeOut`) so persistence can be checked from Telegram.
  - Tests: `pnpm test` now runs `check-callbacks` (golden test pinning the `callback_data` formats; button routing goes through `routeCallback` in `src/controllers/callbackRoutes.ts`), `check-platform` (command matcher and middleware), `check-store` (session store), `check-routes` (route smoke test) and `check-flows` (wizard and reject prompt, including a simulated restart). The last three, and `check-claim`, need `MONGO_URI` and skip without it; CI provides it.
  - Data-safety tooling: a read-only database census (`scripts/census.js`) and a backup/restore runbook (`docs/BACKUP.md`).

1.1.1 - Production deployment. CI publishes the production image to GHCR, and the host runs it from a new `compose.prod.yaml` (issue #82).
  - New `publish-image.yml` workflow: on a `v*` tag (or manually), builds the `production` stage for `linux/amd64` and `linux/arm64` and pushes it to `ghcr.io/sm-26/jsts-salebot`, tagged with the version and `latest`.
  - New `compose.prod.yaml` for the deploy host: pulls the image instead of building, runs it as `node` with no inspector port, binds MongoDB and mongo-express to `127.0.0.1`, and starts mongo-express only with `--profile tools`. It reuses the dev setup's `jsts-salebot_mongodb_data` volume, pins `mongo:8.2` (the version the production data was written with; `latest` is now 9.0), and gives `mongod` 60 seconds to shut down.
  - Fixed shutdown under Docker. Only `SIGINT` was handled, but `docker stop` sends `SIGTERM`, which Node ignores as a container's PID 1 without a handler; every stop waited 10 seconds and then force-killed the bot mid-poll. `SIGTERM` now stops polling and closes Mongo like `SIGINT`.
  - A deliberate shutdown now logs `MongoDB connection closed.` instead of the misleading `MongoDB disconnected. Attempting to reconnect...`.
  - Fixed `config.json.example`, which was not valid JSON (`"faqAllowInGroups": boolean`), so copying it as the setup steps say produced a config the bot could not read. It now holds `false`.

1.1.0 - Production stability. The bot no longer dies on a Telegram error, no longer runs without a database, and two moderators can no longer handle the same post.
  - **Behavior change:** the bot now exits if it cannot reach MongoDB, after `MONGO_MAX_ATTEMPTS` attempts (default 5, 5 seconds apart). `connectDB` previously handled a failed connection by scheduling a background retry and returning normally, so its promise resolved and startup continued: polling began, users were served, and every query sat in Mongoose's command buffer until it timed out. The container logged `Bot is running` with no database behind it. Combined with the new restart policy, Docker now retries until Mongo is reachable instead.
  - **Behavior change:** an admin who abandons the reject-reason prompt now leaves the post rejected without a reason, rather than leaving it pending. This follows from claiming the post at click time; it matches the button that was pressed, and skipping the reason was already a supported outcome.
  - Fixed the crash that took production down. An un-awaited `editMessageText` rejected with a Telegram 400 (`message is not modified`); because it was never awaited, the enclosing `try/catch` could not see it and Node's default unhandled-rejection behaviour killed the process. Unhandled rejections are now logged instead of fatal, `main()`'s failure is caught, and every fire-and-forget `editMessage*` call carries its own labelled `.catch`.
  - Added `restart: unless-stopped` to the `bot` service, which had no restart policy while `mongoserver` and `mongo-express` both did. This is what turned a crash into a two-week outage.
  - Fixed two moderators being able to approve or reject the same post, which notified the author twice. The `status !== "pending"` check was a time-of-check/time-of-use race: `handleRejection` awaits the reason prompt, which waits on a human, and only wrote the status afterwards. Posts are now claimed with an atomic `findOneAndUpdate` filtered on `status: "pending"`, so Mongo picks the winner and the loser gets the "already handled" toast. The claim is released back to `pending` if the subsequent Telegram work throws.
  - Rejection reasons are now persisted. `rejectionReason` has been in the schema all along and `/clearpending` sets it, but the moderation path never wrote it — reasons existed only in the logs. Applies to rejections from this version onward.
  - Quieted polling noise (issue #48). Without a `polling_error` listener the library logs every failure at error level; one Telegram outage produced 19 identical lines in 7 seconds. Transient failures (5xx, `EFATAL`, `ETIMEDOUT`, `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`) now log as warnings noting that polling retries, error level is reserved for real failures such as 401/409, and consecutive repeats collapse into a count.
  - `pnpm test` gained two checks: the moderation claim under concurrency (needs a real `MONGO_URI`, skips without one) and polling-error classification. CI runs a `mongo` service so the former runs there rather than skipping.  

1.0.0 - Out of alpha. Telegram Bot API 10.2, Rich Messages throughout, and a new direct-broadcast command.
  - **Breaking:** `/start` no longer creates a post — it now shows a welcome greeting. Post creation moved to the new `/newPost` command.
  - **Breaking:** `minimumPhotos` is now enforced. The code previously read a `minimumMedia` key that does not exist in `config.json`, so the comparison was always against `undefined` and photo-less posts were silently accepted.
  - **Breaking:** `/config` now validates each value against a per-key schema (`src/services/configSchema.ts`), rejecting input it previously accepted (e.g. a number for `lang`, or an arbitrary string for `mediaLayout`). Nullable keys now store a real `null` instead of the string `"null"`.
  - **Breaking:** minimum Node.js is now 20.19+ (required by Mongoose); Rich Message rendering requires an up-to-date Telegram client.
  - Upgraded `node-telegram-bot-api` 0.67.0 → 1.2.0, adopting Telegram Bot API 10.2. Removed `@types/node-telegram-bot-api`, as v1 ships its own TypeScript definitions. Migrated away from API fields dropped upstream (`forward_from` → `forward_origin`, `disable_web_page_preview` → `link_preview_options`).
  - Posts, `/help`, the moderation card, `/myposts`, `/pending` and the wizard preview now render as **Rich Messages** — headings, block quotes, lists, dividers and media galleries.
  - New `mediaLayout` config key: multiple photos render as a swipeable `"slideshow"` or a `"collage"` grid.
  - Sold posts now strike through the title and show a `🔴 SOLD` marker; approved posts carry a "reply to contact the seller" footer.
  - New `/broadcastUsers` admin command: DMs a text message to the de-duplicated union of active users and pending/approved post authors (excluding the sender), reporting per-recipient delivery failures.
  - Removed the inline-button delay. A media group cannot carry buttons, which forced a second follow-up message everywhere buttons were needed; each of those surfaces is now a single Rich Message with the buttons attached. `sendMediaGroup` is no longer used anywhere.
  - Commands are now case-insensitive (`/newpost`, `/NewPost` and `/NEWPOST` all work).
  - Price validation accepts thousands separators (`2,000` and `2 000`).
  - Wizard text prompts now require text — sending a photo for the location step previously stored an empty value and silently advanced.
  - The `/newPost` wizard shows a "Step N of 5" indicator.
  - Completed localization: `en`/`he`/`ru` are key-consistent with no untranslated values, and several hardcoded user-facing strings (the `/lang` confirmation among them) were moved into the locale files.
  - Migrated the package manager from npm to pnpm, repairing a `package-lock.json` that had unresolved merge-conflict markers committed into it — which had been blocking Dependabot.
  - Fixed CI, which had been failing on every push since the pnpm migration (`pnpm/action-setup` needs a version, now pinned via `packageManager`). Missing FAQ node IDs now warn instead of failing the build. Fixed the Docker build for `node:26`, which no longer bundles Corepack, and added a `.dockerignore`.
  - Fixed the **production** Docker image, which was missing `src/locales`. The locale JSON is read from disk at runtime and `tsc` only emits `.js`, so every user-facing string would have fallen back to its raw key. Note that `config.json` is not baked into the image and must be mounted at `/app/config.json`.
  - Pinned pnpm to a single version across the project: both Docker stages now derive it from the `packageManager` field instead of installing whatever was latest, which had them building with a different pnpm than CI and local.
  - Removed dead code: `MediaService`, `formatPostText`, and dependency `overrides`/`auditConfig` entries pinning packages that are no longer in the tree.  

0.1.6 - Completed RBAC System
  - Replaced `isAdmin` boolean with `authLevel` (0: User, 1: Moderator, 2: Admin) in the user model.
  - Implemented automatic migration of existing users from `isAdmin` to `authLevel`.
  - Added `/promote` command for admins to increase a user's role by one level.
  - Added `/demote` command for admins to decrease role level with zero-admin safety warnings.
  - Added `/auth` command for moderators and admins to view role details.
  - Centralized authorization checks using a `hasAuthLevel` helper.
  - Updated `/help` command to display commands based on the user's role.
  - Added strict audit logging for role changes and failed authorization attempts.  

0.1.5 - Added Admin Broadcast Command.
  - New command `/broadcast` for admins to send messages to the approved channel, either by replying to an existing message or by typing a new message.
  - Admins can also use a test case to test a custom broadcast message, think of it as preview broadcast in the moderation group.  

0.1.4 - Added Admin Active Users monitoring.
  - New command `/activeUsers` for admins to monitor users currently in the middle of creating a post.
  - Displays User ID, Username, and Full Name for all non-idle sessions.  

0.1.3 - Enhanced user post management and moderation logging.
  - Refactored `/myposts` UI: Added a dashboard summary and full message previews for approved posts with dedicated Bump/Sold buttons.
  - Added bulk management: Users can now clear all "Rejected" or "Sold" posts from their history with a single click.
  - Improved API resilience: Added specific handling for Telegram "message not modified" and "message not found" errors to ensure database consistency during sync.
  - Enhanced Admin Auditing: Moderation actions now log detailed metadata including admin details, post content, and author information.
  - Admin Policy Update: Permitted admins to moderate their own posts (logged with a warning for transparency).  

0.1.2 - added Russian support, small fixes as well.  

0.1.1 - Added FAQ module (issue #20 Phase 1): `/faq` command with structured FAQ data in locales, supports user-specific language resolution, comprehensive validation of FAQ file structure in `checkLocals.ts`, and test cases for FAQ functionality.  

0.1.0 - Refactored locale system to support user-specific language preferences. Migrated from monolithic `locals.json` to structured `src/locales/<lang>/common.json` files, added `/lang` command for users to set their preferred language, and implemented automatic language detection from Telegram user settings.  

0.0.5 - Optimized Docker configuration for debugging, updated README documentation, and performed major dependency bumps (including TypeScript 6.0 and Mongoose 9.3).  

0.0.4 - Added admin pending post management (`/pending`, `/clearpending`), updated help menu, and improved admin moderation workflow.  

0.0.3 - Added donation system via Telegram Stars (`/donate`), implemented PaymentService, and added configuration options for enabling/disabling donations.  

0.0.2 - feature parity with GoSaleBot project, implemented /myposts with option to bump and "mark as sold", added ci tests  

0.0.1 - Initial Release in TypeScript after migration from Golang.


For details on each release, refer to the individual commits or release tags.
