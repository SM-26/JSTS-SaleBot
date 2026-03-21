# Changelog

All notable changes to this project will be documented in this file.

## Version History

- 0.3.3 - tried to do a lot of cleanup an safety.
- 0.3.2 - Improved config management: dynamic /config command, centralized config loading with defaults, added APPROVED_TOPIC_ID support, switched to HTML parsing for captions to fix entity errors, enhanced user handling without username using first/last names, added warnings for invalid topic IDs, update to go 1.26 (from 1.22)
- 0.3.1 - User-facing improvement: added `/myposts` command with interactive actions to list, delete, and mark posts as sold. Updated docs and i18n strings; tests added for the new flows.
- 0.3.0 - Major internal refactor: extracted per-state pure handlers and centralized executor, migrated session/post data to typed `PostDraft`/`db.Post`, added pluggable validators (price, photos) controlled by config, and consolidated admin commands. All unit tests updated and passing.
- 0.2.4 - Refactored configuration loading, improved error handling, used constants for post status, and updated documentation.
- 0.2.3 - Added test suit, fixed basic errors with images (still need some work). and version badge
- 0.2.2 - Added help command, improved logging, and fixed several bugs.
- 0.2.1 - Fixing the images problem, added dependabot and templates to the project.
- 0.2.0 - Good working version
- 0.1.0 – Initial private release with FSM, moderation, admin, i18n, Docker, and docs

For details on each release, refer to the individual commits or release tags.
