/**
 * SKALDR — слой подключения к модели.
 *
 * Два режима:
 *   1. connectionProfile === '' → текущий API таверны (context.generateRaw).
 *   2. connectionProfile === id → сохранённый профиль подключения
 *      (context.ConnectionManagerRequestService.sendRequest) — активное
 *      подключение таверны при этом НЕ переключается.
 */

import { LOG_PREFIX, ctx } from './constants.js';
import { getSettings, CURRENT_API } from './settings.js';

/** Встроенное расширение таверны, отвечающее за профили подключений. */
const CONNECTION_MANAGER = 'connection-manager';

/** @returns {boolean} доступен ли менеджер подключений */
export function isConnectionManagerAvailable() {
    const context = ctx();
    if (!context?.ConnectionManagerRequestService) return false;

    const disabled = context.extensionSettings?.disabledExtensions;
    if (Array.isArray(disabled) && disabled.includes(CONNECTION_MANAGER)) return false;

    return Array.isArray(context.extensionSettings?.connectionManager?.profiles);
}

/**
 * Список профилей подключения, пригодных для запросов из расширения.
 * @returns {any[]}
 */
export function getProfiles() {
    if (!isConnectionManagerAvailable()) return [];

    const context = ctx();
    const service = context.ConnectionManagerRequestService;
    const profiles = context.extensionSettings.connectionManager.profiles ?? [];

    return profiles.filter(profile => {
        try {
            return service.isProfileSupported?.(profile) ?? true;
        } catch {
            return false;
        }
    });
}

/**
 * @param {string} profileId
 * @returns {any|null}
 */
export function getProfile(profileId) {
    if (!profileId) return null;
    return getProfiles().find(profile => profile.id === profileId) ?? null;
}

/**
 * Раскладывает профили по группам (Chat Completion / Text Completion).
 * @returns {{ label: string, profiles: any[] }[]}
 */
export function getGroupedProfiles() {
    const context = ctx();
    const service = context?.ConnectionManagerRequestService;
    const profiles = getProfiles();

    let allowedTypes = null;
    try {
        allowedTypes = service?.getAllowedTypes?.();
    } catch {
        allowedTypes = null;
    }

    const apiMap = context?.CONNECT_API_MAP;
    if (!allowedTypes || !apiMap) {
        // Плоский список — тоже рабочий вариант.
        return profiles.length ? [{ label: '', profiles: [...profiles].sort(byName) }] : [];
    }

    const groups = [];
    for (const [apiType, label] of Object.entries(allowedTypes)) {
        const bucket = profiles
            .filter(profile => apiMap[profile.api]?.selected === apiType)
            .sort(byName);
        if (bucket.length) groups.push({ label, profiles: bucket });
    }

    // Профили, не попавшие ни в одну группу, не теряем.
    const grouped = new Set(groups.flatMap(group => group.profiles));
    const rest = profiles.filter(profile => !grouped.has(profile)).sort(byName);
    if (rest.length) groups.push({ label: '', profiles: rest });

    return groups;
}

/**
 * @param {any} a
 * @param {any} b
 * @returns {number}
 */
function byName(a, b) {
    return String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
}

/**
 * Достаёт текст из ответа сервисов таверны.
 * @param {any} response
 * @returns {string}
 */
function extractContent(response) {
    if (typeof response === 'string') return response;
    if (response && typeof response === 'object') {
        return String(response.content ?? response.text ?? '');
    }
    return '';
}

/**
 * Запрос к текущему API таверны.
 * @param {any} context
 * @param {{role: string, content: string}[]} messages
 * @param {number} maxTokens
 * @returns {Promise<string>}
 */
async function requestCurrentApi(context, messages, maxTokens) {
    if (typeof context.generateRaw !== 'function') {
        throw new Error('generateRaw недоступен в этой версии SillyTavern');
    }

    try {
        return await context.generateRaw({
            prompt: messages,
            responseLength: maxTokens,
        });
    } catch (error) {
        // Старые сборки ST принимают только строковую сигнатуру.
        console.warn(`${LOG_PREFIX} generateRaw({...}) не сработал, пробуем старую сигнатуру:`, error);
        const flat = messages.map(message => message.content).join('\n\n');
        try {
            return await context.generateRaw(flat, null, false, false);
        } catch {
            throw error; // отдаём наверх исходную ошибку — она информативнее
        }
    }
}

/**
 * Запрос через сохранённый профиль подключения.
 * @param {any} context
 * @param {string} profileId
 * @param {{role: string, content: string}[]} messages
 * @param {number} maxTokens
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function requestProfile(context, profileId, messages, maxTokens, signal) {
    if (!isConnectionManagerAvailable()) {
        throw new Error('Менеджер подключений недоступен');
    }
    if (!getProfile(profileId)) {
        throw new Error('Выбранный профиль подключения не найден');
    }

    const response = await context.ConnectionManagerRequestService.sendRequest(
        profileId,
        messages,
        maxTokens,
        {
            stream: false,
            extractData: true,
            includePreset: true,
            includeInstruct: true,
            signal: signal ?? null,
        },
    );

    return extractContent(response);
}

/**
 * Главная точка входа: отправляет запрос выбранным способом.
 * @param {object} options
 * @param {{role: string, content: string}[]} options.messages
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>}
 */
export async function requestRewrite({ messages, signal }) {
    const context = ctx();
    if (!context) throw new Error('Контекст SillyTavern недоступен');

    const settings = getSettings();
    const maxTokens = Math.max(1, Number(settings.maxTokens) || 1024);
    const profileId = settings.connectionProfile;

    if (profileId === CURRENT_API || !profileId) {
        return extractContent(await requestCurrentApi(context, messages, maxTokens));
    }

    return await requestProfile(context, profileId, messages, maxTokens, signal);
}

/** Использует ли расширение сейчас текущий API таверны. */
export function usesCurrentApi() {
    const profileId = getSettings().connectionProfile;
    return profileId === CURRENT_API || !profileId;
}
