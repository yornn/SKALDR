/**
 * SKALDR — настройки расширения.
 * Хранятся в extension_settings.skaldr и уезжают на сервер через saveSettingsDebounced().
 */

import { MODULE_NAME, LOG_PREFIX, ctx } from './constants.js';

/** Значение «текущий API таверны» для выпадающего списка подключений. */
export const CURRENT_API = '';

export const defaultSettings = Object.freeze({
    /** id выбранного стиля переписывания */
    style: 'viking',
    /** '' = текущий API таверны, иначе id профиля подключения (Connection Profile) */
    connectionProfile: CURRENT_API,
    /** лимит токенов ответа */
    maxTokens: 1024,
    /** подмешивать текстовые промпты текущего пресета таверны */
    usePreset: false,
    /** подмешивать имя и описание выбранной персоны */
    usePersona: false,
    /** подмешивать карточку персонажа из открытого чата */
    useCharacter: false,
    /** подмешивать записи активных лорбуков */
    useLorebook: false,
    /** подмешивать последние сообщения чата */
    useChat: false,
    /** сколько последних сообщений брать при включённом тумблере «чат» */
    chatDepth: 10,
    /** подтягивать текст из поля ввода при открытии окна */
    autoPull: true,
    /** закрывать окно после вставки результата */
    closeAfterApply: false,
    /** запомненная позиция окна: { left, top } или null */
    panelPos: null,
    /** язык интерфейса расширения: 'auto' | 'en' | 'ru' */
    language: 'auto',
});

/**
 * Возвращает объект настроек, дозаполняя недостающие ключи дефолтами.
 * @returns {typeof defaultSettings}
 */
export function getSettings() {
    const context = ctx();
    if (!context?.extensionSettings) {
        console.warn(`${LOG_PREFIX} extensionSettings недоступны, работаем на дефолтах`);
        return structuredClone(defaultSettings);
    }

    const store = context.extensionSettings;
    if (!store[MODULE_NAME] || typeof store[MODULE_NAME] !== 'object') {
        store[MODULE_NAME] = structuredClone(defaultSettings);
    }

    // Миграция: добавляем ключи, появившиеся в новых версиях.
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(store[MODULE_NAME], key)) {
            store[MODULE_NAME][key] = structuredClone(defaultSettings[key]);
        }
    }

    return store[MODULE_NAME];
}

/** Сохранить настройки (дебаунс на стороне таверны). */
export function saveSettings() {
    ctx()?.saveSettingsDebounced?.();
}

/**
 * Записать одно значение и сохранить.
 * @param {keyof typeof defaultSettings} key
 * @param {any} value
 */
export function setSetting(key, value) {
    const settings = getSettings();
    settings[key] = value;
    saveSettings();
}

/** Инициализация при старте — просто материализует объект настроек. */
export function initSettings() {
    getSettings();
}
