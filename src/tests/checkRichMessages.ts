import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import type { Api } from "node-telegram-bot-api";
import { AuthLevel } from "../types";
import type { BotConfig, MediaItem } from "../types";
import type { BroadcastReport } from "../services/broadcastUsersService";
import { PostService } from "../services/postService";
import type { PostData } from "../services/postService";
import { localeService } from "../services/localeService";
import { buildHelpMessage, buildBroadcastReportMessage, entitiesToRichText } from "../services/richMessages";

// Rich messages are built with RichMessageBuilder, but their wire JSON must stay
// byte-identical to what the hand-built versions produced: posts already in Telegram
// and new ones have to look the same. The GOLDEN functions below are a verbatim COPY
// of those hand-built versions (loose objects, one cast at the boundary); every output
// of the builder-based code is compared to them across a matrix. Do not "modernise"
// the golden copies: they are the reference.

const configPath = path.join(process.cwd(), "config.json");
const baseConfig: BotConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

type Opts = { sold?: boolean; showCta?: boolean; previewLabel?: string; link?: { label: string; url: string } };

function goldenPost(config: BotConfig, data: PostData, opts: Opts = {}): unknown {
    const lang = config.lang;
    const formatUserMentionRich = (userId: number, username?: string, firstName?: string): unknown =>
        username
            ? `@${username}`
            : { type: "text_mention", text: firstName || "User", user: { id: userId, is_bot: false, first_name: firstName || "User" } };

    const bold = (text: unknown) => ({ type: "bold", text });
    const para = (text: unknown) => ({ type: "paragraph", text });
    const item = (text: unknown) => ({ blocks: [para(text)] });

    const titleText = opts.sold ? { type: "strikethrough", text: data.title } : data.title;

    const blocks: unknown[] = [
        ...(opts.previewLabel ? [para(opts.previewLabel)] : []),
        { type: "heading", text: titleText, size: 2 },
        { type: "blockquote", blocks: [para(data.description)] },
        { type: "divider" },
        {
            type: "list",
            items: [
                item(["💰 ", bold(data.price)]),
                item(`📍 ${data.location}`),
                item(["👤 ", formatUserMentionRich(data.userId, data.username, data.firstName)]),
            ],
        },
    ];

    const mediaBlocks = data.media.map((m) =>
        m.type === "video"
            ? { type: "video", video: { type: "video", media: m.fileId } }
            : { type: "photo", photo: { type: "photo", media: m.fileId } }
    );

    if (mediaBlocks.length === 1) {
        blocks.push(mediaBlocks[0]);
    } else if (mediaBlocks.length > 1) {
        const layout = config.mediaLayout ?? "slideshow";
        blocks.push({ type: layout, blocks: mediaBlocks });
    }

    if (opts.link) {
        blocks.push({ type: "footer", text: { type: "url", text: opts.link.label, url: opts.link.url } });
    }

    const footer = opts.sold
        ? localeService.t(lang, "soldTag")
        : opts.showCta ? localeService.t(lang, "contactSellerCta") : null;
    if (footer) {
        blocks.push({ type: "footer", text: footer });
    }

    return { blocks };
}

function goldenHelp(t: (key: string) => string, authLevel: AuthLevel, config: { enableFaq?: boolean; donationsEnabled?: boolean; buyerMatches?: string }): unknown {
    const heading = (key: string, size: number) => ({ type: "heading", text: t(key).replace(/<\/?b>/g, ""), size });
    const cmd = (key: string) => {
        const line = t(key);
        const i = line.indexOf(" - ");
        const text = i === -1 ? line : [{ type: "bold", text: line.slice(0, i) }, line.slice(i)];
        return { blocks: [{ type: "paragraph", text }] };
    };

    const generalCmds = ["helpStart", "helpNewPost", "helpCancel", "helpMyPosts", "helpLang", "helpHelp"];
    if (config.enableFaq !== false) generalCmds.push("helpFaq");
    if (config.donationsEnabled !== false) generalCmds.push("helpDonate");
    if (config.buyerMatches === "on") generalCmds.push("helpAlerts");

    const blocks: unknown[] = [
        heading("helpTitle", 2),
        { type: "list", items: generalCmds.map(cmd) },
    ];

    if (authLevel >= AuthLevel.MOD) {
        blocks.push(
            { type: "divider" },
            heading("helpModSection", 3),
            { type: "list", items: ["helpPending", "helpClearPending", "helpAuth", "helpStats"].map(cmd) },
        );
    }

    if (authLevel >= AuthLevel.ADMIN) {
        blocks.push(
            { type: "divider" },
            heading("helpAdminSection", 3),
            { type: "list", items: ["helpConfig", "helpActiveUsers", "helpPromote", "helpDemote", "helpBroadcastTopic", "helpBroadcastUsers", "helpTest", "helpLabel"].map(cmd) },
        );
    }

    return { blocks };
}

function goldenReport(
    t: (key: string, params?: Record<string, string | number | boolean>) => string,
    report: BroadcastReport,
    mentionById: Map<string, string>
): unknown {
    const blocks: unknown[] = [
        { type: "heading", text: t("broadcastUsersReportTitle"), size: 2 },
        { type: "paragraph", text: t("broadcastUsersReport", { sent: report.sent, failed: report.failures.length, total: report.total }) },
    ];

    if (report.failures.length > 0) {
        const limit = 30; // truncateFailures' default
        const shown = report.failures.slice(0, limit);
        const remainder = Math.max(0, report.failures.length - limit);
        blocks.push(
            { type: "divider" },
            {
                type: "list",
                items: shown.map(f => ({
                    blocks: [{ type: "paragraph", text: `• ${mentionById.get(f.userId) ?? "N/A"} (${f.userId}) — ${f.reason}` }],
                })),
            },
        );

        if (remainder > 0) {
            blocks.push({ type: "paragraph", text: t("broadcastUsersMore", { n: remainder }) });
        }
    }

    return { blocks };
}

// deepStrictEqual ignores key order; the wire string must match too.
function assertSame(actual: unknown, expected: unknown, label: string): void {
    assert.deepStrictEqual(actual, expected, `${label}: structure differs`);
    assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), `${label}: JSON differs`);
}

const photo = (n: number): MediaItem => ({ fileId: `photo-${n}`, type: "photo" });
const video = (n: number): MediaItem => ({ fileId: `video-${n}`, type: "video" });

function checkPosts(): number {
    const mediaMatrix: Record<string, MediaItem[]> = {
        "0 photos": [],
        "1 photo": [photo(1)],
        "3 photos": [photo(1), photo(2), photo(3)],
        "1 video": [video(1)],
        "1 video + 2 photos": [video(1), photo(1), photo(2)],
    };
    const linkOpts = [undefined, { label: "Review", url: "https://t.me/c/123/456" }];
    const users: { username?: string; firstName: string }[] = [
        { username: "seller_name", firstName: "Sam" },
        { firstName: "Sam" },
        { firstName: "" },
    ];

    let cases = 0;
    for (const [mediaName, media] of Object.entries(mediaMatrix)) {
        for (const mediaLayout of ["slideshow", "collage"] as const) {
            const config: BotConfig = { ...baseConfig, mediaLayout };
            const service = new PostService({} as unknown as Api, config);
            for (const sold of [false, true]) {
                for (const showCta of [false, true]) {
                    for (const previewLabel of [undefined, "Preview"]) {
                        for (const link of linkOpts) {
                            for (const user of users) {
                                const data: PostData = {
                                    title: "Item <b>&</b>",
                                    description: "Line 1\nLine 2",
                                    price: "100 ₪",
                                    location: "Tel Aviv",
                                    media,
                                    userId: 42,
                                    ...user,
                                };
                                const opts: Opts = { sold, showCta, previewLabel, link };
                                assertSame(
                                    service.formatPostRichMessage(data, opts),
                                    goldenPost(config, data, opts),
                                    `post [${mediaName}, ${mediaLayout}, ${JSON.stringify(opts)}, ${JSON.stringify(user)}]`
                                );
                                cases++;
                            }
                        }
                    }
                }
            }
        }
    }

    // No opts at all, and an unset mediaLayout (the old code defaulted it to slideshow).
    const noLayout: BotConfig = { ...baseConfig };
    delete noLayout.mediaLayout;
    const service = new PostService({} as unknown as Api, noLayout);
    const data: PostData = { title: "T", description: "D", price: "1", location: "L", media: [photo(1), video(2)], userId: 1, firstName: "A" };
    assertSame(service.formatPostRichMessage(data), goldenPost(noLayout, data), "post [defaults]");
    return cases + 1;
}

function checkHelp(): number {
    let cases = 0;
    const flags = [undefined, true, false];
    for (const lang of localeService.availableLocales) {
        const t = (key: string) => localeService.t(lang, key);
        for (const level of [AuthLevel.USER, AuthLevel.MOD, AuthLevel.ADMIN]) {
            for (const enableFaq of flags) {
                for (const donationsEnabled of flags) {
                    for (const buyerMatches of [undefined, "shadow", "on"]) {
                        const cfg = { enableFaq, donationsEnabled, buyerMatches };
                        assertSame(buildHelpMessage(t, level, cfg), goldenHelp(t, level, cfg), `help [${lang}, level ${level}, ${JSON.stringify(cfg)}]`);
                        cases++;
                    }
                }
            }
        }
    }

    // Synthetic strings: <b> tags in titles are stripped, a line without " - " stays a bare string.
    const fake = (key: string) => {
        if (key === "helpTitle" || key.endsWith("Section")) return `<b>${key}</b>`;
        return key.length % 2 ? `/${key} - text` : "no dash here";
    };
    for (const level of [AuthLevel.USER, AuthLevel.MOD, AuthLevel.ADMIN]) {
        assertSame(buildHelpMessage(fake, level, {}), goldenHelp(fake, level, {}), `help [synthetic, level ${level}]`);
        cases++;
    }
    return cases;
}

function checkReport(): number {
    const failure = (n: number) => ({ userId: String(1000 + n), reason: n % 2 ? "blocked the bot" : "hasn't started the bot" });
    const reports: Record<string, BroadcastReport> = {
        "no failures": { total: 5, sent: 5, failures: [] },
        "two failures": { total: 5, sent: 3, failures: [failure(0), failure(1)] },
        "exactly the limit": { total: 40, sent: 10, failures: Array.from({ length: 30 }, (_, i) => failure(i)) },
        "over the limit": { total: 80, sent: 10, failures: Array.from({ length: 45 }, (_, i) => failure(i)) },
    };
    const mentions = new Map([["1000", "@first"], ["1001", "N/A"], ["1002", "@third"]]);

    let cases = 0;
    for (const lang of localeService.availableLocales) {
        const t = (key: string, params?: Record<string, string | number | boolean>) => localeService.t(lang, key, params);
        for (const [name, report] of Object.entries(reports)) {
            assertSame(buildBroadcastReportMessage(t, report, mentions), goldenReport(t, report, mentions), `report [${lang}, ${name}]`);
            cases++;
        }
    }
    return cases;
}

// entitiesToRichText: expected RichText written by hand. Offsets are UTF-16 code units
// (an emoji is 2, a Hebrew letter 1).
function checkEntities(): number {
    const e = (type: string, offset: number, length: number, extra: Record<string, unknown> = {}) => ({ type, offset, length, ...extra });
    const user = { id: 5, is_bot: false, first_name: "Dana" };
    const cases: [string, string, ReturnType<typeof e>[] | undefined, unknown][] = [
        ["no entities", "plain text", undefined, "plain text"],
        ["empty entities", "plain text", [], "plain text"],
        ["only plain-mapped types", "a @b #c https://x.test", [e("mention", 2, 2), e("hashtag", 5, 2), e("url", 8, 14), e("blockquote", 0, 4)], "a @b #c https://x.test"],
        ["spoiler", "ab secret cd", [e("spoiler", 3, 6)], ["ab ", { type: "spoiler", text: "secret" }, " cd"]],
        ["bold at the start", "bold rest", [e("bold", 0, 4)], [{ type: "bold", text: "bold" }, " rest"]],
        ["whole text", "abc", [e("italic", 0, 3)], [{ type: "italic", text: "abc" }]],
        ["pre becomes code", "x = 1", [e("pre", 0, 5, { language: "ts" })], [{ type: "code", text: "x = 1" }]],
        ["text_link", "see the shop", [e("text_link", 4, 8, { url: "https://x.test" })], ["see ", { type: "url", text: "the shop", url: "https://x.test" }]],
        ["text_link without url is plain", "see the shop", [e("text_link", 4, 8)], "see the shop"],
        ["text_mention", "hi Dana", [e("text_mention", 3, 4, { user })], ["hi ", { type: "text_mention", text: "Dana", user }]],
        ["custom_emoji is a leaf", "x\u{1F525}y", [e("custom_emoji", 1, 2, { custom_emoji_id: "999" })], ["x", { type: "custom_emoji", custom_emoji_id: "999", alternative_text: "\u{1F525}" }, "y"]],
        ["bold nested in a link", "see the shop now", [e("text_link", 4, 8, { url: "https://x.test" }), e("bold", 8, 4)],
            ["see ", { type: "url", text: ["the ", { type: "bold", text: "shop" }], url: "https://x.test" }, " now"]],
        ["nesting does not depend on input order", "see the shop now", [e("bold", 8, 4), e("text_link", 4, 8, { url: "https://x.test" })],
            ["see ", { type: "url", text: ["the ", { type: "bold", text: "shop" }], url: "https://x.test" }, " now"]],
        ["same range: first entity is the outer one", "abc", [e("bold", 0, 3), e("italic", 0, 3)], [{ type: "bold", text: { type: "italic", text: "abc" } }]],
        ["Hebrew after an emoji", "\u{1F600} שלום עולם", [e("bold", 3, 4), e("italic", 8, 4)],
            ["\u{1F600} ", { type: "bold", text: "שלום" }, " ", { type: "italic", text: "עולם" }]],
        ["adjacent pair", "ab", [e("bold", 0, 1), e("italic", 1, 1)], [{ type: "bold", text: "a" }, { type: "italic", text: "b" }]],
        ["overlapping pair is split at the boundary", "0123456789", [e("bold", 0, 5), e("italic", 3, 5)],
            [{ type: "bold", text: ["012", { type: "italic", text: "34" }] }, { type: "italic", text: "567" }, "89"]],
        ["contained then trailing overlap", "0123456789", [e("bold", 0, 10), e("italic", 2, 3), e("spoiler", 4, 4)],
            [{ type: "bold", text: ["01", { type: "italic", text: ["23", { type: "spoiler", text: "4" }] }, { type: "spoiler", text: "567" }, "89"] }]],
        ["out-of-range and empty entities are ignored", "abc", [e("bold", 2, 5), e("bold", -1, 2), e("bold", 1, 0)], "abc"],
        ["a cut inside an emoji is ignored", "a\u{1F600}b", [e("bold", 2, 1), e("italic", 0, 2)], "a\u{1F600}b"],
    ];

    for (const [name, text, entities, expected] of cases) {
        assertSame(entitiesToRichText(text, entities), expected, `entities [${name}]`);
    }

    // In a post: the description paragraph inside the blockquote carries the RichText;
    // everything else is the unchanged golden output.
    const service = new PostService({} as unknown as Api, { ...baseConfig });
    const data: PostData = { title: "T", description: "ab secret cd", descriptionEntities: [e("spoiler", 3, 6)], price: "1", location: "L", media: [], userId: 1, firstName: "A" };
    const golden = goldenPost(baseConfig, { ...data, descriptionEntities: undefined }) as { blocks: { type: string; blocks?: { type: string; text: unknown }[] }[] };
    golden.blocks.find(b => b.type === "blockquote")!.blocks![0].text = ["ab ", { type: "spoiler", text: "secret" }, " cd"];
    assertSame(service.formatPostRichMessage(data), golden, "post with a spoiler description");
    return cases.length + 1;
}

function run() {
    console.log("[INFO] Checking rich message wire JSON against the hand-built reference...");
    const posts = checkPosts();
    const help = checkHelp();
    const reports = checkReport();
    const entities = checkEntities();
    console.log(`[SUCCESS] Rich messages identical to the reference (${posts} post, ${help} help, ${reports} report cases; ${entities} entity cases).`);
}

run();
