// INTERIM (issue #84, phase 4): a tiny stand-in for v1's `bot.on(...)` +
// `bot.removeListener(...)`, which the /newPost wizard (InputService) and the
// reject-reason prompt (ModerationService) still depend on. Deleted in phase 5,
// when persistent flows (expectReply/expectCallback + sessions) replace it.
import type { Context, Middleware } from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api/types";

export type MessageListener = (msg: Message) => void;
/** Return true when the listener consumed the button press (stops the chain). */
export type CallbackListener = (query: CallbackQuery) => boolean | void;

export class TemporaryListeners {
    private messageListeners: MessageListener[] = [];
    private callbackListeners: CallbackListener[] = [];

    on(event: "message", listener: MessageListener): void;
    on(event: "callback_query", listener: CallbackListener): void;
    on(event: "message" | "callback_query", listener: MessageListener | CallbackListener): void {
        if (event === "message") this.messageListeners.push(listener as MessageListener);
        else this.callbackListeners.push(listener as CallbackListener);
    }

    removeListener(event: "message", listener: MessageListener): void;
    removeListener(event: "callback_query", listener: CallbackListener): void;
    removeListener(event: "message" | "callback_query", listener: MessageListener | CallbackListener): void {
        if (event === "message") this.messageListeners = this.messageListeners.filter(l => l !== listener);
        else this.callbackListeners = this.callbackListeners.filter(l => l !== listener);
    }

    middleware(): Middleware<Context> {
        return async (ctx, next) => {
            if (ctx.message) {
                // v1 semantics: every listener sees the message, then the main handlers do too.
                for (const listener of [...this.messageListeners]) listener(ctx.message);
                await next();
                return;
            }

            if (ctx.callbackQuery) {
                let consumed = false;
                for (const listener of [...this.callbackListeners]) {
                    if (listener(ctx.callbackQuery) === true) consumed = true;
                }
                if (consumed) return;
            }

            await next();
        };
    }
}
