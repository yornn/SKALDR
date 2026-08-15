/**
 * SKALDR — общие константы.
 */

/** Ключ модуля в extension_settings. Должен быть уникальным среди всех расширений. */
export const MODULE_NAME = 'skaldr';

/** Префикс для логов в консоли. */
export const LOG_PREFIX = '[SKALDR]';

/** Версия (держим в синхроне с manifest.json). */
export const VERSION = '0.3.0';

/**
 * Корень папки расширения. Считается из import.meta.url, поэтому работает
 * независимо от того, как называется папка при установке
 * (SKALDR / SillyTavern-SKALDR / что угодно).
 */
const EXTENSION_ROOT = new URL('../', import.meta.url);

/**
 * Абсолютный URL до файла внутри расширения.
 * @param {string} relativePath путь относительно корня расширения, напр. 'locales/ru.json'
 * @returns {string}
 */
export function assetUrl(relativePath) {
    return new URL(relativePath, EXTENSION_ROOT).href;
}

/**
 * Короткий доступ к контексту SillyTavern.
 * Специально не импортируем /scripts/extensions.js — глобальный SillyTavern.getContext()
 * стабильнее и не ломается при переездах файлов таверны.
 * @returns {any}
 */
export function ctx() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}
