# Changelog

All notable changes to this project will be documented in this file.

## Version History

0.1.2 - added Russian support, small fixes as well.
0.1.1 - Added FAQ module (issue #20 Phase 1): `/faq` command with structured FAQ data in locales, supports user-specific language resolution, comprehensive validation of FAQ file structure in `checkLocals.ts`, and test cases for FAQ functionality.
0.1.0 - Refactored locale system to support user-specific language preferences. Migrated from monolithic `locals.json` to structured `src/locales/<lang>/common.json` files, added `/lang` command for users to set their preferred language, and implemented automatic language detection from Telegram user settings.
0.0.5 - Optimized Docker configuration for debugging, updated README documentation, and performed major dependency bumps (including TypeScript 6.0 and Mongoose 9.3).
0.0.4 - Added admin pending post management (`/pending`, `/clearpending`), updated help menu, and improved admin moderation workflow.
0.0.3 - Added donation system via Telegram Stars (`/donate`), implemented PaymentService, and added configuration options for enabling/disabling donations.
0.0.2 - feature parity with GoSaleBot project, implemented /myposts with option to bump and "mark as sold", added ci tests
0.0.1 - Initial Release in TypeScript after migration from Golang.


For details on each release, refer to the individual commits or release tags.
