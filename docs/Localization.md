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
