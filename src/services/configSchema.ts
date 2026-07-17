import { localeService } from "./localeService";

/**
 * Per-key validation rules for /config.
 *
 * Without this, /config inferred the type from the *current* value, so any
 * string key (lang, mediaLayout) accepted anything, and null-valued keys
 * (typeof null === "object") were treated as strings — which is how
 * `broadcastTopicId` could end up as the string "null" instead of null.
 */
export type ConfigFieldSpec =
    | { kind: "boolean" }
    | { kind: "number"; nullable?: boolean; min?: number }
    | { kind: "enum"; values: () => readonly string[] };

export const CONFIG_SCHEMA: Record<string, ConfigFieldSpec> = {
    lang: { kind: "enum", values: () => localeService.availableLocales },
    mediaLayout: { kind: "enum", values: () => ["slideshow", "collage"] },

    moderationGroupId: { kind: "number" },
    approvedGroupId: { kind: "number" },
    moderationTopicId: { kind: "number", nullable: true },
    approvedTopicId: { kind: "number", nullable: true },
    broadcastTopicId: { kind: "number", nullable: true },

    timeOut: { kind: "number", min: 0 },
    minimumPhotos: { kind: "number", min: 0 },
    dailyBumpLimit: { kind: "number", min: 0 },

    validatePrice: { kind: "boolean" },
    donationsEnabled: { kind: "boolean" },
    enableFaq: { kind: "boolean" },

    // ponytail: these three live in config.json but nothing reads them yet;
    // typed here so /config still validates rather than accepting anything.
    faqAllowInGroups: { kind: "boolean" },
    faqMaxButtonsPerRow: { kind: "number", min: 1 },
    faqMaxDepth: { kind: "number", nullable: true, min: 1 },
};

export type ParseResult =
    | { ok: true; value: string | number | boolean | null }
    | { ok: false; expected: string };

/** Pure: validate/coerce a raw /config value against the key's spec. */
export function parseConfigValue(key: string, raw: string): ParseResult {
    const spec = CONFIG_SCHEMA[key];
    if (!spec) return { ok: false, expected: "a known config key" };

    const value = raw.trim();

    if (spec.kind === "boolean") {
        if (value === "true") return { ok: true, value: true };
        if (value === "false") return { ok: true, value: false };
        return { ok: false, expected: "true or false" };
    }

    if (spec.kind === "number") {
        if (spec.nullable && value === "null") return { ok: true, value: null };
        const num = Number(value);
        if (value === "" || !Number.isFinite(num)) {
            return { ok: false, expected: spec.nullable ? "a number or null" : "a number" };
        }
        if (spec.min !== undefined && num < spec.min) {
            return { ok: false, expected: `a number >= ${spec.min}` };
        }
        return { ok: true, value: num };
    }

    const allowed = spec.values();
    if (allowed.includes(value)) return { ok: true, value };
    return { ok: false, expected: allowed.join(" | ") };
}
