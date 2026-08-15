/**
 * SKALDR — стили переписывания и сборка промптов.
 *
 * Системное сообщение собирается слоями, в этом порядке:
 *   1. пресет таверны   — как пишет автор пресета (если тумблер включён);
 *   2. prompts/base.md  — общие правила переписывания, одинаковые для всех стилей;
 *   3. prompts/<стиль>.md — голос выбранного стиля;
 *   4. блок контекста   — персона, карточка, лорбук, чат (по тумблерам).
 *
 * Черновик пользователя уходит отдельным user-сообщением, как есть.
 *
 * Тексты промптов лежат в отдельных файлах, чтобы править их можно было
 * без правки кода. Новый стиль = один объект в SKALD_STYLES, свой .md
 * и пара ключей в locales/*.json.
 */

import { assetUrl, LOG_PREFIX, ctx } from './constants.js';
import { getSettings } from './settings.js';
import { buildContextBlock, getPresetInfo } from './context.js';

/** Общий слой промпта. */
const BASE_PROMPT_FILE = 'prompts/base.md';

/** Пояснение, которое идёт следом за текстом пресета. */
const PRESET_NOTE_FILE = 'prompts/preset-note.md';

/** Шапка справочного блока с контекстом. */
const CONTEXT_NOTE_FILE = 'prompts/context-note.md';

/** Разделитель между слоями системного промпта. */
const LAYER_SEPARATOR = '\n\n---\n\n';

/**
 * @typedef {object} SkaldStyle
 * @property {string} id         технический id (уходит в настройки)
 * @property {string} icon       класс иконки Font Awesome
 * @property {string} nameKey    ключ i18n для названия
 * @property {string} descKey    ключ i18n для описания
 * @property {string} promptFile путь к файлу со слоем стиля
 */

/** @type {SkaldStyle[]} */
export const SKALD_STYLES = [
    {
        id: 'viking',
        icon: 'fa-solid fa-hammer',
        nameKey: 'style.viking.name',
        descKey: 'style.viking.desc',
        promptFile: 'prompts/viking.md',
    },
    {
        id: 'slav',
        icon: 'fa-solid fa-sun',
        nameKey: 'style.slav.name',
        descKey: 'style.slav.desc',
        promptFile: 'prompts/slav.md',
    },
];

/**
 * Аварийный промпт на случай, если файлы не подгрузились: цепочка должна
 * остаться рабочей, пусть и без тонкой настройки.
 */
const FALLBACK_BASE = [
    'You are a rewriting engine for roleplay drafts.',
    'Rewrite the draft so the prose reads better.',
    'Preserve intent, point of view, tense, every fact, all direct speech and the author\'s markup.',
    'Keep the language of the draft. Add nothing, continue nothing, explain nothing.',
    'Return only the rewritten draft.',
].join(' ');

const cache = {
    base: '',
    presetNote: '',
    contextNote: '',
    styles: /** @type {Record<string, string>} */ ({}),
    loaded: false,
};

/**
 * @param {string} relativePath
 * @returns {Promise<string>}
 */
async function loadPromptFile(relativePath) {
    try {
        const response = await fetch(assetUrl(relativePath));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.text()).trim();
    } catch (error) {
        console.warn(`${LOG_PREFIX} не удалось загрузить промпт ${relativePath}:`, error);
        return '';
    }
}

/** Загружает все слои промптов. Вызывать один раз при старте. */
export async function initPrompts() {
    const [base, presetNote, contextNote, ...styleTexts] = await Promise.all([
        loadPromptFile(BASE_PROMPT_FILE),
        loadPromptFile(PRESET_NOTE_FILE),
        loadPromptFile(CONTEXT_NOTE_FILE),
        ...SKALD_STYLES.map(style => loadPromptFile(style.promptFile)),
    ]);

    cache.base = base || FALLBACK_BASE;
    cache.presetNote = presetNote;
    cache.contextNote = contextNote;
    SKALD_STYLES.forEach((style, index) => {
        cache.styles[style.id] = styleTexts[index] ?? '';
    });
    cache.loaded = true;

    if (!base) console.warn(`${LOG_PREFIX} базовый промпт не загружен, работаем на аварийном`);
}

/**
 * @param {string} styleId
 * @returns {SkaldStyle}
 */
export function getStyle(styleId) {
    return SKALD_STYLES.find(style => style.id === styleId) ?? SKALD_STYLES[0];
}

/**
 * Раскрывает макросы таверны ({{user}}, {{char}} и прочие) в тексте промпта.
 * @param {string} text
 * @returns {string}
 */
function substituteMacros(text) {
    try {
        return ctx()?.substituteParams?.(text) ?? text;
    } catch (error) {
        console.warn(`${LOG_PREFIX} подстановка макросов не удалась:`, error);
        return text;
    }
}

/**
 * Слой пресета: текст текущего пресета плюс пояснение, что брать из него
 * нужно только манеру письма, а не указания играть за персонажа.
 * @returns {string}
 */
function buildPresetLayer() {
    if (!getSettings().usePreset) return '';

    const { text } = getPresetInfo();
    if (!text) return '';

    return [
        '# House style guide — the author\'s generation preset',
        text,
        cache.presetNote,
    ].filter(Boolean).join('\n\n');
}

/**
 * Справочный блок с контекстом таверны.
 * @param {string} draftText
 * @returns {Promise<string>}
 */
async function buildContextLayer(draftText) {
    const block = await buildContextBlock(draftText);
    if (!block) return '';

    return [cache.contextNote, block].filter(Boolean).join('\n\n');
}

/**
 * Собирает системный промпт: пресет → общие правила → стиль → контекст.
 * @param {string} styleId
 * @param {string} [draftText] нужен для сканирования лорбуков
 * @returns {Promise<string>}
 */
export async function buildSystemPrompt(styleId, draftText = '') {
    if (!cache.loaded) console.warn(`${LOG_PREFIX} промпты ещё не загружены`);

    const style = getStyle(styleId);
    const layers = [
        buildPresetLayer(),
        cache.base || FALLBACK_BASE,
        cache.styles[style.id],
        await buildContextLayer(draftText),
    ]
        .map(layer => String(layer ?? '').trim())
        .filter(Boolean);

    return substituteMacros(layers.join(LAYER_SEPARATOR));
}

/**
 * Собирает сообщения для запроса к модели.
 * Черновик уходит как есть — его макросы таверна раскроет сама при отправке.
 * @param {string} styleId
 * @param {string} text исходный текст пользователя
 * @returns {Promise<{ role: 'system'|'user'|'assistant', content: string }[]>}
 */
export async function buildMessages(styleId, text) {
    const draft = String(text ?? '').trim();
    const system = await buildSystemPrompt(styleId, draft);

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: draft });
    return messages;
}

/**
 * Подчищает ответ модели: срезает размышления и обёртки в кодблок.
 * @param {string} raw
 * @returns {string}
 */
export function cleanResult(raw) {
    let text = String(raw ?? '')
        .replace(/<think(?:ing)?[\s>][\s\S]*?<\/think(?:ing)?>/gi, '')
        .trim();

    // ```...``` вокруг всего ответа
    const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(text);
    if (fenced) text = fenced[1].trim();

    return text;
}
