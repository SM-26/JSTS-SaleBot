# Architecture

Rules for changing the code are in [`Agents.md`](https://github.com/SM-26/JSTS-SaleBot/blob/master/Agents.md).

## Stack

Node.js and TypeScript, `node-telegram-bot-api` v2 (a middleware chain with `Context`, an `Api` taking params objects, `createSession`), MongoDB through `mongoose`, and Docker Compose. Build targets are in the `dockerfile`: `development` and `production`.

## Where things are

| Folder | Holds |
| :--- | :--- |
| `src/controllers/` | Routing. `botController.ts` builds the middleware chain in `registerRoutes()` |
| `src/services/` | Business logic, one file per flow |
| `src/repositories/` | All Mongoose queries |
| `src/models/` | Schemas |
| `src/types/index.ts` | Shared interfaces, including `BotConfig` and `LocaleStrings` |
| `src/locales/` | Strings and FAQ, per language ([Localization](Localization.md)) |
| `src/tests/` | The checks ([Testing](Testing.md)) |
| `scripts/` | `catchup.ts` (export scan) and `census.js` ([Backup](BACKUP.md)) |

| Flow | Start at |
| :--- | :--- |
| `/newPost` wizard | `src/services/wizardService.ts` |
| Post formatting and sending | `src/services/postService.ts`, `src/services/tierLayouts.ts` |
| Publish or send to moderation | `src/services/publishService.ts`, `src/services/trustService.ts` |
| Approve and reject | `src/services/moderationService.ts` |
| Take-down | `src/services/takeDownService.ts` |
| `/myposts` | `src/services/myPostsService.ts` |
| Capture and classifier | `src/services/captureService.ts`, `src/services/shadowService.ts`, `src/services/classifier.ts` |
| Capture notes and group listings | `src/services/captureNoteService.ts`, `src/services/groupListingService.ts` |
| Buyer notes and alerts | `src/services/buyerNoteService.ts`, `src/services/savedSearchService.ts`, `src/services/alertService.ts` |
| Refresh, nudge and expiry | `src/services/lifecycleService.ts`, `src/services/staleCheckService.ts` |
| Catch-up | `src/services/catchupService.ts`, `src/services/catchupScan.ts` |
| Interval jobs | `src/services/sweeper.ts` |
| Private notes (ephemeral API) | `src/services/ephemeralNotes.ts` |
| Callback formats | `src/controllers/callbackRoutes.ts` |

The design behind the market redesign, as a record of why things are as they are, is in [`design/`](https://github.com/SM-26/JSTS-SaleBot/tree/master/design). It's history, not a guide: these wiki pages describe how the bot works today.

## Post lifecycle
```
User sends /newPost (or, with config.quickListing, a photo/video/album with a caption in DM and no draft:
                       a quick draft is built from the caption; album items are collected, preview 1.5 s after the last;
                       a wanted caption gets matches (buyerMatches on) or a one-line pointer instead; missing title/price/minimumPhotos go to that wizard step)
  → WizardService walks the user's draft (collection `drafts`): title, description, price, location, media
  → PostService shows preview
      (blocked words, including those in hidden link URLs, are stopped here, for everyone, trusted sellers included)
      (with quickListing every preview has edit buttons and the Beit Dagan meetup toggle; `meetup` shows
       as `📍 location · בית דגן`, and the words of the place in a post's location line link to start=faq_1)
  → User confirms
  → Post saved to DB (status: "pending")
  → PublishService.submitPost:
      → trusted seller (approved or sold post, no moderator take-down in 90 days)
          → status: "approved", posted to approved group at once; the moderation group gets a
            "Published (trusted seller)" card with Take down, reviewed after publishing
      → new seller → PostService forwards to moderation group
      → ModerationService: admin approves → status: "approved", posted to approved group (card has Take down when its listing exists)
      → ModerationService: admin rejects  → status: "rejected"; the moderator picks a preset reason (rr_),
                                            or REPLIES to the prompt (old Skip buttons still work); the user is notified
                                            exactly once (claimRejectionNotice), with "Fix and resend" and the rules link
      → TakeDownService: moderator takes down a published post (td_) → listing "taken_down", group message
                         removed, author told, trust revoked for 90 days; the post can no longer be bumped or sold
  → User can /myposts:
      → Mark as "sold"  → updates approved group message with sold tag
      → Bump post       → re-posts with updated timestamp (subject to dailyBumpLimit); the button is Telegram's disabled type at the limit
      → Change price    → `lp_` prompt (session `pendingPriceCut`, reply-to); a cut re-posts without using a bump and sets `previousPrice` (struck through on tier layouts), a raise is a counted bump and clears it
  → LifecycleService (listings, not posts): 7 days without refresh → nudge DM (only with config.nudges);
      30 days → listing "expired" (always; the approved bot post stays "approved", its group message is untouched);
      /myposts offers Relist on an expired bot listing; the admin's /stalecheck asks legacy (hold) sellers once
```


## State and persistence
Nothing a user or moderator is in the middle of lives in process memory: a restart must lose nothing. There is no in-memory session map and no `isIdle` flag.
- **Wizard state** lives in the `drafts` collection (`Draft` model, `draftRepository`): one document per user with the step, the answers, the media and `promptMessageId`. `WizardService` reads the user's draft on every update. Wizard buttons (Done-media, Confirm, Cancel, Continue/Start over) are valid only against the draft itself: it exists, its step matches and the pressed message is `promptMessageId`. Anything else falls through to `staleButtonCatchAll`, which answers "expired".
- **Quick drafts** (`quickListing`): the draft also holds `quick`, `collecting`, `mediaGroupId` and `caption`. An album's items are appended atomically; a per-user in-memory timer (user id only) sends the preview 1.5 s after the last item, and a restart loses only that send (`/newpost` then Continue resends).
- **Expiry**: `isDraftExpired(draft, config.timeOut)` is checked on every touch against the live `timeOut` (minutes, 0 = never). There is deliberately no TTL index; startup deletes drafts already past `timeOut`.
- **v2 sessions** (`createSession` in `BotController`, backed by `MongoSessionStore`, collection `bot_sessions`) are keyed `chat:user` (`sessionKey()`) with a 3-day idle TTL. They hold only the donation custom-amount flag, the moderator's pending reject-reason prompts (`pendingRejects`), a buyer's one-reply fix for a thin `/alerts` text (`pendingAlertFix`: prompt message id and time, valid 1 hour; with a `searchId` it replaces that search) and the admin's pending `/stalecheck` send (`pendingStalecheck`, tied to its dry-run message by `promptMessageId`). Reject prompts use v2 `expectReply`/`expectCallback` markers keyed on the prompt message id.
- **Slice 1 fields** (`posts.rejectionNotifiedAt`, `drafts.fixing`) are optional and additive: the 2.0.1 image ignores them. `fixing` marks a wizard re-asking one field after a blocked word.
- **Market collections** (`listings`, `captures` with a 7-day TTL, `shadow_log` with a 120-day TTL, `members`) are additive like the two above: v1 ignores them, nothing in `posts`/`users` changed, and rolling back to the 2.0.1 image against the same database still works (the new collections are harmless leftovers). Capture windows are rows in `captures` (90 s window, closed after 30 s of quiet), advanced by the sweeper started in `bot.ts`; there is no in-memory window state.
- **Session data** also holds `pendingStalecheck` (the admin's pending `/stalecheck` dry run, confirmed with `sc_go` or dropped with `sc_no`).
- **Slice 2 fields** are optional and additive too: `captures.note.kind` (`ask`/`refresh`; both count toward the 3 notes per seller per 24 h), `members.declined` (hash and date of every text a note was sent for, answered or not, kept 30 days, 20 hashes max, so a member is never nagged about the same text) and `drafts.captureId` (a `/start c_` draft prefilled from a capture). `/start c_` refuses to overwrite a live draft, and nothing else creates capture drafts, because an older image's wizard would post one as a bot post. After a rollback the `mk_`/`ls_` buttons do nothing and `/myposts` does not show group listings.
- **Slice 5 fields** are optional and additive: `drafts.quick`, `drafts.collecting`, `drafts.mediaGroupId`, `drafts.caption` and `meetup` on `drafts`, `posts` and `listings`. The album preview timer is in memory and holds only the user id: a restart loses only the send, and `/newpost` then Continue resends (the draft is in Mongo, `claimCollecting` is the guard). After a rollback to 3.1.0 the fields are ignored and the `draft_edit_*` / `draft_meetup_*` buttons answer as stale.
- **Slice 4 fields** are optional and additive: new collections `saved_searches` (60-day TTL on `expiresAt`, in every mode) and `alert_log` (unique per search and listing), plus `shadow_log.matchLabel*`, `shadow_log.buyerNoteAt`, `members.lastBuyerNoteAt` and `listings.meetup`. A saved search holds the parsed query, never the original message; it stays and resumes when `buyerMatches` goes back to `on`, except that a 403 (the buyer blocked the bot) deletes that buyer's searches, and the 60-day TTL deletes the rest. After a rollback the `al_` buttons answer "expired" and `s_` links fall to the greeting.
- **Slice 3 fields** are optional and additive: `listings.nudgeHeld` (a nudge was claimed but could not be delivered; it waits for the seller's next sale-topic message) and `listings.staleSentAt` (set by `/stalecheck`, starts the 7-day answer window). `posts` and `users` are unchanged. After a rollback to 3.1.0 the `lc_`/`sc_` buttons do nothing and nothing expires or nudges; the fields are ignored.
- **3.4.1:** `shadow_log.label` can also be `gone` (`/label` → 🔗 Dead link). Additive: older images never write it, and 3.4.0 still reads such a row (its `/stats` counts it as labeled but in neither sale nor not sale).
- **Slice 6 fields** are optional and additive: `members.pendingCatchup` (a seller's offered items) and `members.catchup` (`importedAt`, `armedAt`, `sentAt`, the held note), and `listings.origin: "catchup"`. Stamps outlive the items: `sentAt` alone blocks a second offer. `catchup.json` and the export hold member text and never enter the repo (gitignored). After a rollback to an older image, `ck_` falls to the stale catch-all, `k_` falls to the greeting, `members.catchup` is ignored and added listings stay.
- A new multi-step flow stores its state in a document or in session data, never in an in-memory `Map`. `drafts` and `bot_sessions` are additive: keep their documents backward-compatible, and never change existing `posts`/`users` fields without a migration plan (see `docs/BACKUP.md`).
