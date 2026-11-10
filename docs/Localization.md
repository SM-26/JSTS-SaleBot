# Localization

Every user-facing string lives in `src/locales/<lang>/common.json` (`en`, `he`, `ru`), with the same keys in each file. Never hardcode text in a service.

`LocaleService` picks the language in this order: `preferredLocale` (from `/lang`), then `languageCode` (Telegram's hint), then `lang` from `config.json`. A missing key falls back to the key string with a warning.

When adding a string, add it to **every** language and run `pnpm run check-locals`.

## Adding a language

1. Create `src/locales/<lang>/` with `common.json` and `faq.json`, filling in every key.
2. Run `pnpm run check-locals`, which reports anything missing.
3. Set `lang` in `config.json` to make it the default. Users can override it with `/lang`.

## The FAQ

`/faq` reads `src/locales/<lang>/faq.json`, a tree keyed by dot notation:

```json
{
    "meta": { "locale": "en" },
    "nodes": {
        "1": "Main topic",
        "1.1": "Sub-topic",
        "1.1.1": "Deeper",
        "2": "Second topic"
    }
}
```

- `meta.locale` must match the folder name.
- Values are plain single-line strings.
- Number without gaps, and change the structure in every language together.
- **Node `1` must stay the Beit Dagan meeting point.** The `faq_1` start link is frozen and opens it.

`pnpm run check-locals` validates the structure.

### The widget

In a private chat `/faq` is a Telegram widget built from the same tree (`src/services/faqWidget.ts`): a tab per top-level node, a card per second-level node, the answers inside. The 📄 Text version button under it, and any chat where the widget can't be sent, use the text FAQ above.

- An answer that is only an `https://` link becomes a pill named after the site (Waze, Google Maps, WhatsApp; any other site shows its host).
- An Israeli phone number in an answer becomes a 📋 button that copies it, plus a WhatsApp link for a mobile number. Widgets can't open the dialer: `tel:` links are ignored.
- Hebrew text gets right-to-left marks around brackets and after punctuation that follows a number, because widgets draw those wrong without them.
- The whole widget must stay under 4096 bytes after compression. English is the largest (about 3.3 KB in November 2026). `check-rich` fails when a language goes over; then shorten that FAQ.
