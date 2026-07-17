# Changelog

All notable changes to this project will be documented in this file.


## Version History
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
