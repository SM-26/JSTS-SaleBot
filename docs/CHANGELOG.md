# Changelog

All notable changes to this project will be documented in this file.


## Version History
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
