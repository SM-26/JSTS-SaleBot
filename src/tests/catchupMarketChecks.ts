import assert from "assert";
import Member from "../models/Member";
import listingRepository from "../repositories/listingRepository";
import memberRepository from "../repositories/memberRepository";
import type { CatchupFile, CatchupItem } from "../services/catchupScan";
import { CatchupService } from "../services/catchupService";
import { GroupListingService } from "../services/groupListingService";
import { LifecycleService } from "../services/lifecycleService";
import type { BotConfig } from "../types";
import { createHarness, type HarnessOptions } from "./harness";
import { asPostService, stubPostService } from "./lifecycleFakes";

// Catch-up offers on members and their delivery (slice 6), run from check-market.
export async function catchupMarketChecks(RUN: string, CHAT: number, odIds: string[]): Promise<void> {
    // catch-up offers on members (slice 6)
    {
    const CU = new Date();
    const DAYMS = 24 * 3600 * 1000;
    const ago = (days: number) => new Date(CU.getTime() - days * DAYMS);
    const cuItem = (id: number): CatchupItem => ({ messageId: id, date: ago(2).toISOString(), title: "Glock", price: "1,300", text: "Glock 17 1,300", tier: "strict" });
    const cu = (n: string) => `${RUN}-cu-${n}`;

    const m1 = cu("a");
    assert.strictEqual(await memberRepository.importCatchup(m1, [cuItem(1), cuItem(2)], CU), true, "import");
    assert.strictEqual(await memberRepository.claimCatchupDelivery(m1, CU), null, "claim before arming");
    assert.strictEqual(await memberRepository.armCatchup(CU) >= 1, true, "arm counts");
    const won = await memberRepository.claimCatchupDelivery(m1, CU);
    assert.ok(won?.catchup?.sentAt && won.pendingCatchup?.length === 2, "claim after arming returns the member with sentAt");
    assert.strictEqual(await memberRepository.claimCatchupDelivery(m1, CU), null, "second claim");
    assert.strictEqual(await memberRepository.importCatchup(m1, [cuItem(3)], CU), false, "import on a sent member");

    const m2 = cu("race");
    await memberRepository.importCatchup(m2, [cuItem(1)], CU);
    await memberRepository.armCatchup(CU);
    const claims = await Promise.all([1, 2, 3, 4, 5].map(() => memberRepository.claimCatchupDelivery(m2, CU)));
    assert.strictEqual(claims.filter(Boolean).length, 1, "5 concurrent claims, one winner");
    await memberRepository.releaseCatchupDelivery(m2);
    assert.ok(!(await Member.collection.findOne({ userId: m2 }))!.catchup.sentAt, "release unsets sentAt");
    assert.ok(await memberRepository.claimCatchupDelivery(m2, CU), "claimable again after release");

    const m3 = cu("old");
    await memberRepository.importCatchup(m3, [cuItem(1)], CU);
    await memberRepository.armCatchup(ago(31));
    assert.strictEqual(await memberRepository.claimCatchupDelivery(m3, CU), null, "armed 31 days ago");
    await memberRepository.dropExpiredCatchups(CU);
    const m3doc = (await Member.collection.findOne({ userId: m3 }))!;
    assert.ok(m3doc.pendingCatchup === undefined && m3doc.catchup.armedAt, "expired armed: items gone, stamps stay");

    const m4 = cu("neverarmed");
    await memberRepository.importCatchup(m4, [cuItem(1)], ago(31));
    await memberRepository.dropExpiredCatchups(CU);
    assert.strictEqual((await Member.collection.findOne({ userId: m4 }))!.pendingCatchup, undefined, "never-armed import older than 30 days purged");
    const m4b = cu("neverarmed-fresh");
    await memberRepository.importCatchup(m4b, [cuItem(1)], ago(29));
    await memberRepository.dropExpiredCatchups(CU);
    assert.ok((await Member.collection.findOne({ userId: m4b }))!.pendingCatchup, "fresh never-armed import kept");

    for (const [name, days, kept] of [["sent29", 29, true], ["sent31", 31, false]] as const) {
        const id = cu(name);
        await memberRepository.importCatchup(id, [cuItem(1)], ago(40));
        await Member.updateOne({ userId: id }, { $set: { "catchup.armedAt": ago(40), "catchup.sentAt": ago(days) } });
        await memberRepository.dropExpiredCatchups(CU);
        assert.strictEqual(!!(await Member.collection.findOne({ userId: id }))!.pendingCatchup, kept, `delivered ${days} days ago`);
    }

    const nv = cu("never");
    await memberRepository.setAskMode(nv, "never", CU);
    assert.strictEqual(await memberRepository.importCatchup(nv, [cuItem(1)], CU), false, "import on askMode never");
    const re = cu("reimport");
    await memberRepository.importCatchup(re, [cuItem(1)], CU);
    await memberRepository.armCatchup(CU);
    assert.strictEqual(await memberRepository.importCatchup(re, [cuItem(9)], CU), true, "re-import");
    const redoc = (await Member.collection.findOne({ userId: re }))!;
    assert.ok(!redoc.catchup.armedAt && redoc.pendingCatchup.length === 1 && redoc.pendingCatchup[0].messageId === 9, "re-import clears armedAt and replaces items");

    const tk = cu("take");
    const tid = async () => String((await memberRepository.findByUserId(tk))!._id);
    await memberRepository.importCatchup(tk, [cuItem(1), cuItem(2)], CU);
    assert.strictEqual(await memberRepository.takeCatchupItem(await tid(), 1), null, "take before sentAt");
    await memberRepository.armCatchup(CU);
    await memberRepository.claimCatchupDelivery(tk, CU);
    const tidv = await tid();
    const taken = await memberRepository.takeCatchupItem(await tid(), 1);
    assert.strictEqual(taken?.messageId, 1, "first take");
    assert.strictEqual(await memberRepository.takeCatchupItem(await tid(), 1), null, "second take");
    await memberRepository.restoreCatchupItem(await tid(), taken!);
    const takes = await Promise.all([1, 2, 3, 4, 5].map(() => memberRepository.takeCatchupItem(tidv, 1)));
    assert.strictEqual(takes.filter(Boolean).length, 1, "restored item takable once among 5 concurrent");
    await memberRepository.setCatchupNote(tk, 77);
    assert.strictEqual((await memberRepository.findByUserId(tk))!.catchup?.note?.ephemeralMessageId, 77, "setCatchupNote");
    await memberRepository.dropCatchup(await tid());
    const tkdoc = (await Member.collection.findOne({ userId: tk }))!;
    assert.ok(tkdoc.pendingCatchup === undefined && tkdoc.catchup.sentAt, "dropCatchup unsets items only");
    const counts = await memberRepository.catchupCounts();
    assert.ok(counts.imported >= 1 && counts.sent >= 1 && counts.armed >= 1 && counts.items >= 1, "catchupCounts");

    const item = cuItem(4242);
    const cl = await listingRepository.createFromCatchup({ chatId: CHAT, messageId: 4242, sellerId: cu("l"), sellerName: "L", item, isBundle: false }, CU);
    assert.ok(cl.origin === "catchup" && cl.source === "group" && cl.status === "live" && cl.media.length === 0, "createFromCatchup fields");
    assert.strictEqual(cl.refreshedAt.getTime(), new Date(item.date).getTime(), "refreshedAt is the post date");
    assert.strictEqual(cl.createdAt.getTime(), CU.getTime(), "createdAt is now");
    assert.strictEqual(cl.priceValue, 1300);
    assert.strictEqual((await listingRepository.findLiveByMessage(CHAT, 4242))?._id.toString(), String(cl._id), "findLiveByMessage finds it");

    const raw = (await Member.collection.findOne({ userId: m1 }))!;
    assert.ok(raw.firstSeenAt && raw.askMode === "ask" && raw.catchup, "3.1.0 fields intact, catchup added");
    const album = await listingRepository.createFromCatchup({ chatId: CHAT, messageId: 4250, sellerId: cu("l"), sellerName: "L", item: { ...cuItem(4250), messageIds: [4250, 4251] }, isBundle: false }, CU);
    assert.deepStrictEqual([...album.messageIds], [4250, 4251], "a listing keeps every message of the window");
    console.log("[OK] catch-up offers.");
    }

    // catch-up offer delivery (slice 6): CatchupService against a recording fake Telegram
    {
    const DAYMS = 24 * 3600 * 1000;
    const ago = (days: number) => new Date(Date.now() - days * DAYMS);
    const item = (id: number, days = 2): CatchupItem => ({ messageId: id, date: ago(days).toISOString(), title: "Glock", price: "1,300", text: "Glock 17 1,300", tier: "strict" });
    const cfg = { captureMode: "optin", approvedGroupId: CHAT, approvedTopicId: 1, lang: "en" } as BotConfig;
    let odSeq = 8_100_000_000 + (Date.now() % 100_000_000) * 10;
    const fresh = () => { const id = String(odSeq++); odIds.push(id); return id; };
    const boot = (responses?: HarnessOptions["responses"]) => {
        const h = createHarness({ responses });
        const svc = new CatchupService(h.bot.api, cfg, new GroupListingService(h.bot.api, cfg, () => "bot", new LifecycleService(h.bot.api, cfg, asPostService(stubPostService()), () => "bot")), () => "bot");
        return { h, svc };
    };
    const notes = (h: ReturnType<typeof boot>["h"]) => h.calls.filter(c => c.method === "sendMessage");
    const stamps = async (id: string) => (await Member.collection.findOne({ userId: id }))!;
    const now = () => new Date();

    // unarmed: nothing goes out
    {
        const { h, svc } = boot();
        const u = fresh();
        await memberRepository.importCatchup(u, [item(1)], now());
        await svc.onSaleTopicMessage(u, now());
        assert.strictEqual(notes(h).length, 0, "unarmed offer: no sendMessage");
    }

    // armed: exactly one ephemeral note, never twice
    const sentUser = fresh();
    {
        const { h, svc } = boot();
        await memberRepository.importCatchup(sentUser, [item(1), item(2)], now());
        await memberRepository.armCatchup(now());
        await svc.onSaleTopicMessage(sentUser, now());
        assert.strictEqual(notes(h).length, 1, "armed: one note");
        const p = notes(h)[0].params;
        assert.strictEqual((p.ephemeral_message_parameters as { receiver_user_id: number }).receiver_user_id, Number(sentUser));
        assert.strictEqual(Number(p.chat_id), CHAT);
        const memberId = String((await stamps(sentUser))._id);
        const buttons = (p.reply_markup as { inline_keyboard: { url?: string }[][] }).inline_keyboard.flat();
        assert.ok(buttons.some(b => b.url === `https://t.me/bot?start=k_${memberId}`), "the k_ URL");
        assert.ok((await stamps(sentUser)).catchup.note.ephemeralMessageId >= 5000, "note id stored");
        await svc.onSaleTopicMessage(sentUser, now());
        assert.strictEqual(notes(h).length, 1, "second message: nothing more");
    }

    // shadow mode holds the offer; optin then delivers
    {
        const { h, svc } = boot();
        const u = fresh();
        await memberRepository.importCatchup(u, [item(1)], now());
        await memberRepository.armCatchup(now());
        cfg.captureMode = "shadow";
        try { await svc.onSaleTopicMessage(u, now()); } finally { cfg.captureMode = "optin"; }
        assert.strictEqual(notes(h).length, 0, "shadow: nothing sent");
        assert.ok((await stamps(u)).pendingCatchup && !(await stamps(u)).catchup.sentAt, "shadow: offer still held");
        await svc.onSaleTopicMessage(u, now());
        assert.strictEqual(notes(h).length, 1, "optin delivers the held offer");
    }

    // armed 31 days ago: no note, purge drops it
    {
        const { h, svc } = boot();
        const u = fresh();
        await memberRepository.importCatchup(u, [item(1)], ago(32));
        await Member.updateOne({ userId: u }, { $set: { "catchup.armedAt": ago(31) } });
        await svc.onSaleTopicMessage(u, now());
        assert.strictEqual(notes(h).length, 0, "armed 31 days ago: no note");
        await memberRepository.dropExpiredCatchups(now());
        assert.strictEqual((await stamps(u)).pendingCatchup, undefined, "purge drops it");
    }

    // every item older than 30 days: no note, items dropped
    {
        const { h, svc } = boot();
        const u = fresh();
        await memberRepository.importCatchup(u, [item(1, 40), item(2, 35)], now());
        await memberRepository.armCatchup(now());
        await svc.onSaleTopicMessage(u, now());
        assert.strictEqual(notes(h).length, 0, "stale items: no note");
        assert.strictEqual((await stamps(u)).pendingCatchup, undefined, "stale items dropped");
        assert.ok(!(await stamps(u)).catchup.sentAt, "nothing sent: the claim is released");
    }

    // a failing send releases the claim; the next message delivers once
    {
        let fail = true;
        const { h, svc } = boot({ sendMessage: () => (fail ? { ok: false, error_code: 400, description: "Bad Request: nope" } : undefined) });
        const u = fresh();
        await memberRepository.importCatchup(u, [item(1)], now());
        await memberRepository.armCatchup(now());
        const realError = console.error;
        console.error = () => {};
        try { await svc.onSaleTopicMessage(u, now()); } finally { console.error = realError; }
        assert.ok(!(await stamps(u)).catchup.sentAt, "failed send: claim released");
        fail = false;
        await svc.onSaleTopicMessage(u, now());
        await svc.onSaleTopicMessage(u, now());
        assert.strictEqual(notes(h).filter(c => (c.result as { ephemeral_message_id?: number }).ephemeral_message_id !== undefined).length, 1, "delivered once after the retry");
    }

    // importFile end to end
    {
        const { svc } = boot();
        const a = fresh();
        const b = fresh();
        const c = fresh();
        const file: CatchupFile = { version: 1, generatedAt: now().toISOString(), sellers: [
            { userId: a, name: "A", items: [item(1), item(2)] },
            { userId: b, name: "B", items: [item(3)] },
            { userId: sentUser, name: "S", items: [item(4)] }, // already offered
            { userId: c, name: "C", items: [] },
        ] };
        assert.deepStrictEqual(await svc.importFile(file, now()), { sellers: 2, items: 3, skipped: 2 }, "import counts");
        assert.strictEqual((await stamps(a)).pendingCatchup.length, 2);
        assert.ok(!(await stamps(a)).catchup.armedAt && !(await stamps(a)).catchup.sentAt, "imported, not armed, not sent");
        assert.strictEqual((await stamps(sentUser)).pendingCatchup.length, 2, "sent member untouched");
    }
    console.log("[OK] catch-up offer delivery.");
    }
}
