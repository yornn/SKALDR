/**
 * SKALDR — локализация.
 *
 * Своя, независимая от словаря таверны: ключи помечаются атрибутом
 * data-skaldr-i18n, чтобы штатный переводчик ST их не трогал.
 *
 *   t('main.skal')                 → "SKÁL!"
 *   t('status.error', { msg: e })  → подстановка {{msg}}
 */

import { assetUrl, LOG_PREFIX, ctx } from './constants.js';
import { getSettings } from './settings.js';

const SUPPORTED_LANGS = ['en', 'ru'];
const FALLBACK_LANG = 'en';

let currentLang = FALLBACK_LANG;
let currentData = {};
let fallbackData = {};

/**
 * Приводит код языка к поддерживаемому ('ru-RU' → 'ru').
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeLang(raw) {
    if (!raw) return null;
    const lower = String(raw).toLowerCase().replace(/_/g, '-');
    const base = lower.split('-')[0];
    return SUPPORTED_LANGS.includes(base) ? base : null;
}

/** Определяет язык: настройка расширения → язык интерфейса ST → язык браузера → en. */
function detectLang() {
    const configured = getSettings().language;
    if (configured && configured !== 'auto') {
        return normalizeLang(configured) ?? FALLBACK_LANG;
    }

    let stLocale = null;
    try {
        stLocale = ctx()?.getCurrentLocale?.();
    } catch {
        stLocale = null;
    }

    return normalizeLang(stLocale)
        ?? normalizeLang(globalThis.navigator?.language)
        ?? FALLBACK_LANG;
}

/**
 * @param {string} lang
 * @returns {Promise<Record<string, any>>}
 */
async function loadLocale(lang) {
    try {
        const response = await fetch(assetUrl(`locales/${lang}.json`));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.warn(`${LOG_PREFIX} не удалось загрузить локаль ${lang}:`, error);
        return {};
    }
}

/** Загружает словари. Вызывать один раз при старте. */
export async function initI18n() {
    currentLang = detectLang();
    fallbackData = await loadLocale(FALLBACK_LANG);
    currentData = currentLang === FALLBACK_LANG ? fallbackData : await loadLocale(currentLang);
}

/** @returns {string} текущий код языка */
export function getLanguage() {
    return currentLang;
}

/**
 * @param {Record<string, any>} data
 * @param {string} key
 * @returns {string|undefined}
 */
function lookup(data, key) {
    let node = data;
    for (const part of key.split('.')) {
        if (!node || typeof node !== 'object') return undefined;
        node = node[part];
    }
    return typeof node === 'string' ? node : undefined;
}

/**
 * Перевод по ключу с подстановкой {{vars}}.
 * @param {string} key
 * @param {Record<string, any>} [vars]
 * @returns {string}
 */
export function t(key, vars = {}) {
    const raw = lookup(currentData, key) ?? lookup(fallbackData, key) ?? key;
    return raw.replace(/\{\{(\w+)\}\}/g, (match, name) => (
        Object.hasOwn(vars, name) ? String(vars[name]) : match
    ));
}

/**
 * Проставляет переводы во всём поддереве.
 * Поддерживаются: data-skaldr-i18n (текст), -title, -placeholder.
 * @param {ParentNode} root
 */
export function applyI18n(root) {
    if (!root) return;

    for (const element of root.querySelectorAll('[data-skaldr-i18n]')) {
        element.textContent = t(element.dataset.skaldrI18n);
    }
    for (const element of root.querySelectorAll('[data-skaldr-i18n-title]')) {
        element.title = t(element.dataset.skaldrI18nTitle);
    }
    for (const element of root.querySelectorAll('[data-skaldr-i18n-placeholder]')) {
        element.placeholder = t(element.dataset.skaldrI18nPlaceholder);
    }
}
