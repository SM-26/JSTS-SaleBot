# Changelog

All notable changes to this project will be documented in this file.


## Version History
Unreleased - Dependency update.
  - The blocked-word list (`src/config/blockedWords.json`) is read from disk and re-read within about 60 s of a change, so the owner can edit it on the server with no rebuild or restart. `compose.prod.yaml` mounts a host folder (`./blocklist`) and points `BLOCKED_WORDS_PATH` into it, falling back to the built-in list when the file is missing; see the deploy note in `docs/README.md`. A bad edit keeps the last good list. `/config` now treats `constructor`, `toString` and other `Object.prototype` names as unknown keys.
  - Upgraded `node-telegram-bot-api` 2.2.0 → 2.3.0 (pinned exactly). No code changes were needed and nothing the user sees changes. Notable library changes: a graceful stop (`SIGINT`/`SIGTERM`) now confirms the update being handled, so a deploy no longer redelivers it; `bot.init()` calls `getMe()` once at startup. The bot's own command matcher is unchanged.
  - `pnpm-workspace.yaml` exempts `node-telegram-bot-api@2.3.0` from pnpm's `minimumReleaseAge` (the release was under 24 hours old). It can be removed after 2026-11-05.

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
