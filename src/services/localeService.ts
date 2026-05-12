import fs from 'fs';
import path from 'path';
import { LocaleService, BotConfig, User } from '../types/index.js';

const configPath = path.join(process.cwd(), 'config.json');
const config: BotConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

class LocaleServiceImpl implements LocaleService {
    private localesDir = path.join(process.cwd(), 'src', 'locales');
    private _availableLocales: string[] = [];
    private messagesCache: Map<string, Record<string, string>> = new Map();

    constructor() {
        this.discoverLocales();
    }

    get availableLocales(): string[] {
        return [...this._availableLocales]; // Return a copy to prevent mutation
    }

    private discoverLocales() {
        try {
            this._availableLocales = fs.readdirSync(this.localesDir).filter(dir =>
                fs.statSync(path.join(this.localesDir, dir)).isDirectory()
            );
            console.info('[INFO - LocaleService] discovered locales', this._availableLocales);
        } catch (error) {
            console.error('[ERROR - LocaleService] Failed to discover locales:', error);
            this._availableLocales = [];
        }
    }

    private normalizeLocale(locale: string): string {
        if (!locale) return '';
        const base = locale.split('-')[0];
        return this._availableLocales.includes(base) ? base : '';
    }

    resolveUserLocale(user: User | null): string {
        // const userIdentifier = user?.userName || user?.userId || 'unknown';
        // console.debug('[DEBUG - LocaleService] resolveUserLocale called', { user: userIdentifier, preferredLocale: user?.preferredLocale, languageCode: user?.languageCode });
        // user.preferredLocale > user.languageCode normalized > config default
        if (user?.preferredLocale) {
            const normalized = this.normalizeLocale(user.preferredLocale);
            if (normalized) {
                // console.info('[INFO - LocaleService] resolved locale from preferredLocale', normalized);
                return normalized;
            }
            console.warn(`[WARN - LocaleService] User ${user.userId} preferredLocale '${user.preferredLocale}' unsupported.`);
        }
        if (user?.languageCode) {
            const normalized = this.normalizeLocale(user.languageCode);
            if (normalized) {
                // console.info('[INFO - LocaleService] resolved locale from languageCode', normalized);
                return normalized;
            }
            console.warn(`[WARN - LocaleService] User ${user.userId} languageCode '${user.languageCode}' unsupported.`);
        }
        console.warn(`[WARN - LocaleService] Falling back to default locale '${config.lang}' for user ${user?.userId || 'unknown'} as no preferredLocale or languageCode provided.`);
        return config.lang;
    }

    getMessages(locale: string, namespace: string = 'common'): Record<string, string> {
        const key = `${locale}-${namespace}`;
        // console.info('[INFO - LocaleService] getMessages', { locale, namespace, key });

        if (this.messagesCache.has(key)) {
            // console.info('[INFO - LocaleService] getMessages cache hit', key);
            return this.messagesCache.get(key)!;
        }

        try {
            const filePath = path.join(this.localesDir, locale, `${namespace}.json`);
            const content = fs.readFileSync(filePath, 'utf-8');
            const messages = JSON.parse(content);
            this.messagesCache.set(key, messages);
            return messages;
        } catch (error) {
            console.error(`[ERROR - LocaleService] Failed to load messages for ${locale}/${namespace}:`, error);
            return {};
        }
    }

    t(locale: string, key: string, params?: Record<string, string | number | boolean>): string {
        // console.info('[INFO - LocaleService] translation requested', { locale, key });
        const messages = this.getMessages(locale);
        let text = messages[key];

        if (!text) {
            console.warn('[WARN - LocaleService] missing translation key', { locale, key });
            text = key; // fallback to key if not found
        }

        if (params) {
            for (const [param, value] of Object.entries(params)) {
                text = text.split(`{${param}}`).join(String(value));
            }
        }

        return text;
    }

    getFaqs(locale: string): Record<string, string> {
        const cacheKey = `${locale}-faq`;
        if (this.messagesCache.has(cacheKey)) {
            return this.messagesCache.get(cacheKey)!;
        }

        try {
            const filePath = path.join(this.localesDir, locale, 'faq.json');
            const content = fs.readFileSync(filePath, 'utf-8');
            const faqData = JSON.parse(content);
            const nodes = faqData.nodes || {};
            this.messagesCache.set(cacheKey, nodes);
            return nodes;
        } catch (error) {
            console.error(`[ERROR - LocaleService] Failed to load FAQ for ${locale}:`, error);
            return {};
        }
    }
}

export const localeService = new LocaleServiceImpl();