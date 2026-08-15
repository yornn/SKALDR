/**
 * SKALDR — сбор контекста таверны для более точного переписывания.
 *
 * Пять независимых тумблеров:
 *   пресет   — текстовые промпты текущего пресета (его форматирование и логика);
 *   персона  — имя и описание выбранной персоны;
 *   бот      — карточка персонажа из открытого чата;
 *   лорбук   — записи активных лорбуков, сработавшие на текст черновика;
 *   чат      — последние N сообщений, N задаётся отдельно.
 *
 * Историю чата расширение читает ТОЛЬКО если тумблер «чат» включён, и ровно
 * на заданную глубину. Ничего не сканируется «на всякий случай».
 */

import { LOG_PREFIX, ctx } from './constants.js';
import { getSettings } from './settings.js';

/** id «глобального» порядка промптов в пресетах chat completion. */
const GLOBAL_PROMPT_ORDER_ID = 100001;

/** Модуль таверны нужен только ради имён активных лорбуков. */
const WORLD_INFO_MODULE = '/scripts/world-info.js';
let worldInfoModulePromise = null;

/** @returns {Promise<any|null>} */
function loadWorldInfoModule() {
    if (!worldInfoModulePromise) {
        worldInfoModulePromise = import(WORLD_INFO_MODULE).catch(error => {
            console.warn(`${LOG_PREFIX} модуль world-info недоступен:`, error);
            return null;
        });
    }
    return worldInfoModulePromise;
}

/* ------------------------------------------------------------------ */
/* Пресет                                                              */
/* ------------------------------------------------------------------ */

/**
 * Текстовые промпты пресета chat completion.
 * Маркеры (история чата, описание персонажа, лорбук) пропускаются: их
 * содержимое расширение подставляет само, по своим тумблерам.
 * @param {any} context
 * @returns {string}
 */
function getChatCompletionPresetText(context) {
    const settings = context.chatCompletionSettings;
    const prompts = Array.isArray(settings?.prompts) ? settings.prompts : [];
    const orderLists = Array.isArray(settings?.prompt_order) ? settings.prompt_order : [];
    if (!prompts.length) return '';

    const findOrder = id => orderLists.find(list => String(list?.character_id) === String(id))?.order;
    const order = findOrder(context.characterId)
        ?? findOrder(GLOBAL_PROMPT_ORDER_ID)
        ?? orderLists[0]?.order
        ?? [];

    const byIdentifier = new Map(prompts.map(prompt => [prompt?.identifier, prompt]));
    const parts = [];

    for (const entry of order) {
        if (!entry?.enabled) continue;

        const prompt = byIdentifier.get(entry.identifier);
        if (!prompt || prompt.marker) continue;

        const content = String(prompt.content ?? '').trim();
        if (content) parts.push(content);
    }

    return parts.join('\n\n');
}

/**
 * Системный промпт text completion.
 * @param {any} context
 * @returns {string}
 */
function getTextCompletionPresetText(context) {
    const sysprompt = context.powerUserSettings?.sysprompt;
    if (!sysprompt?.enabled) return '';
    return String(sysprompt.content ?? '').trim();
}

/**
 * Текущий пресет промптов: имя и текст.
 * @returns {{ name: string, text: string }}
 */
export function getPresetInfo() {
    const context = ctx();
    if (!context) return { name: '', text: '' };

    let name = '';
    try {
        name = String(context.getPresetManager?.()?.getSelectedPresetName?.() ?? '').trim();
    } catch (error) {
        console.warn(`${LOG_PREFIX} имя пресета получить не удалось:`, error);
    }

    let text = '';
    try {
        text = context.mainApi === 'openai'
            ? getChatCompletionPresetText(context)
            : getTextCompletionPresetText(context);
    } catch (error) {
        console.warn(`${LOG_PREFIX} текст пресета получить не удалось:`, error);
    }

    return { name, text };
}

/* ------------------------------------------------------------------ */
/* Персона и карточка                                                  */
/* ------------------------------------------------------------------ */

/** @returns {{ name: string, description: string }} */
export function getPersonaInfo() {
    const context = ctx();
    return {
        name: String(context?.name1 ?? '').trim(),
        description: String(context?.powerUserSettings?.persona_description ?? '').trim(),
    };
}

/** @returns {{ name: string, fields: Record<string, string> }} */
export function getCharacterInfo() {
    const context = ctx();
    if (!context) return { name: '', fields: {} };

    let name = '';
    if (context.groupId) {
        name = String(context.groups?.find(group => String(group?.id) === String(context.groupId))?.name ?? '').trim();
    } else {
        name = String(context.characters?.[context.characterId]?.name ?? context.name2 ?? '').trim();
    }

    let fields = {};
    try {
        fields = context.getCharacterCardFields?.() ?? {};
    } catch (error) {
        console.warn(`${LOG_PREFIX} поля карточки получить не удалось:`, error);
    }

    return { name, fields };
}

/* ------------------------------------------------------------------ */
/* Лорбуки                                                             */
/* ------------------------------------------------------------------ */

/**
 * Имена всех активных лорбуков: глобальные, книга персонажа, книга чата,
 * книга персоны и дополнительные книги карточки.
 * @returns {Promise<string[]>}
 */
export async function getLorebookNames() {
    const context = ctx();
    if (!context) return [];

    const names = new Set();
    const worldInfo = await loadWorldInfoModule();

    for (const name of worldInfo?.selected_world_info ?? []) {
        if (name) names.add(name);
    }

    const chatBook = worldInfo?.METADATA_KEY ? context.chatMetadata?.[worldInfo.METADATA_KEY] : null;
    if (chatBook) names.add(chatBook);

    const character = context.characters?.[context.characterId];
    if (character?.data?.extensions?.world) names.add(character.data.extensions.world);

    const personaBook = context.powerUserSettings?.persona_description_lorebook;
    if (personaBook) names.add(personaBook);

    // Дополнительные книги, привязанные к файлу карточки.
    const charLore = worldInfo?.world_info?.charLore;
    if (Array.isArray(charLore) && character?.avatar) {
        const fileName = String(character.avatar).replace(/\.[^/.]+$/, '');
        const extra = charLore.find(entry => entry?.name === fileName);
        for (const book of extra?.extraBooks ?? []) {
            if (book) names.add(book);
        }
    }

    return [...names];
}

/**
 * Записи лорбуков, сработавшие на переданный текст.
 * Запускается в режиме dry run: таймеры sticky/cooldown реальной генерации
 * не расходуются и события таверны не летят.
 * @param {string[]} scanCorpus строки для сканирования, новые первыми
 * @returns {Promise<string>}
 */
async function getLoreText(scanCorpus) {
    const context = ctx();
    if (typeof context?.getWorldInfoPrompt !== 'function') return '';
    if (!scanCorpus.length) return '';

    try {
        const result = await context.getWorldInfoPrompt(scanCorpus, Number(context.maxContext) || 4096, true);
        return String(result?.worldInfoString ?? '').trim();
    } catch (error) {
        console.warn(`${LOG_PREFIX} сканирование лорбуков не удалось:`, error);
        return '';
    }
}

/* ------------------------------------------------------------------ */
/* Чат                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Последние N видимых сообщений, от старых к новым.
 * @param {number} depth
 * @returns {string[]}
 */
export function getChatLines(depth) {
    const context = ctx();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const limit = Math.max(0, Number(depth) || 0);
    if (!limit) return [];

    return chat
        .filter(message => message && !message.is_system && String(message.mes ?? '').trim())
        .slice(-limit)
        .map(message => `${message.name ?? '???'}: ${String(message.mes).trim()}`);
}

/* ------------------------------------------------------------------ */
/* Сборка блока контекста                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
function section(title, body) {
    const text = String(body ?? '').trim();
    return text ? `## ${title}\n\n${text}` : '';
}

/**
 * Собирает справочный блок из включённых тумблеров.
 * @param {string} draftText черновик — он же корпус для сканирования лорбуков
 * @returns {Promise<string>}
 */
export async function buildContextBlock(draftText) {
    const settings = getSettings();
    const draft = String(draftText ?? '').trim();
    const sections = [];

    if (settings.usePersona) {
        const persona = getPersonaInfo();
        const body = [
            persona.name ? `Name: ${persona.name}` : '',
            persona.description,
        ].filter(Boolean).join('\n\n');
        const built = section('The author\'s persona — this is who the draft is written as', body);
        if (built) sections.push(built);
    }

    if (settings.useCharacter) {
        const character = getCharacterInfo();
        const body = [
            character.name ? `Name: ${character.name}` : '',
            character.fields.description ? `Description:\n${character.fields.description}` : '',
            character.fields.personality ? `Personality:\n${character.fields.personality}` : '',
            character.fields.scenario ? `Scenario:\n${character.fields.scenario}` : '',
            character.fields.charDepthPrompt ? `Notes:\n${character.fields.charDepthPrompt}` : '',
        ].filter(Boolean).join('\n\n');
        const built = section('The character the draft is addressed to', body);
        if (built) sections.push(built);
    }

    const chatLines = settings.useChat ? getChatLines(settings.chatDepth) : [];

    if (settings.useLorebook) {
        // Корпус для сканирования: черновик первым как самое свежее «сообщение».
        const corpus = [draft, ...[...chatLines].reverse()].filter(Boolean);
        const built = section('Setting lore', await getLoreText(corpus));
        if (built) sections.push(built);
    }

    if (chatLines.length) {
        const built = section(
            `The last ${chatLines.length} lines of the conversation, oldest first`,
            chatLines.join('\n\n'),
        );
        if (built) sections.push(built);
    }

    return sections.join('\n\n');
}

/**
 * Короткая сводка для окна настроек: что именно уйдёт в запрос.
 * Лорбуки здесь не сканируются — берутся только имена активных книг.
 * @returns {Promise<{preset: ?{name: string, empty: boolean}, persona: ?{name: string},
 *                    character: ?{name: string}, lorebook: ?{names: string[]}}>}
 */
export async function getContextSummary() {
    const settings = getSettings();

    let preset = null;
    if (settings.usePreset) {
        const info = getPresetInfo();
        preset = { name: info.name, empty: !info.text };
    }

    return {
        preset,
        persona: settings.usePersona ? { name: getPersonaInfo().name } : null,
        character: settings.useCharacter ? { name: getCharacterInfo().name } : null,
        lorebook: settings.useLorebook ? { names: await getLorebookNames() } : null,
    };
}
