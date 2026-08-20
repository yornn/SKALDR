/**
 * SKALDR — стили переписывания и сборка промптов.
 *
 * Системное сообщение собирается слоями, в этом порядке:
 *   1. пресет таверны   — как пишет автор пресета (если тумблер включён);
 *   2. prompts/base.md  — общие правила переписывания, одинаковые для всех стилей;
 *   3. prompts/<стиль>.md — голос выбранного стиля;
 *   4. блок контекста   — персона, карточка, лорбук, чат (по тумблерам);
 *   5. prompts/length*.md — целевая длина результата.
 *
 * Длина идёт последней намеренно: это единственное указание с числами, и с ним
 * заметно лучше, когда модель читает его прямо перед черновиком, а не за
 * километром справочного контекста.
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

/** Слой длины: заданная пользователем цель в словах. */
const LENGTH_FILE = 'prompts/length.md';

/** Слой длины для режима «как в черновике» (targetWords = 0). */
const LENGTH_AUTO_FILE = 'prompts/length-auto.md';

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
 * @typedef {object} LengthPreset
 * @property {string} id      технический id
 * @property {string} nameKey ключ i18n для названия
 * @property {number} words   что подставляем в поле при выборе (0 = авто)
 * @property {number} [min]   нижняя граница коридора, слов
 * @property {number} [max]   верхняя граница коридора, слов
 */

/**
 * Готовые длины. Коридор min–max уходит в промпт как есть, поэтому «коротко»
 * это буквально 40–70 слов, а не «примерно 55 ± сколько-то».
 * @type {LengthPreset[]}
 */
export const LENGTH_PRESETS = [
    { id: 'auto', nameKey: 'length.auto', words: 0 },
    { id: 'short', nameKey: 'length.short', words: 55, min: 40, max: 70 },
    { id: 'medium', nameKey: 'length.medium', words: 200, min: 150, max: 250 },
    { id: 'long', nameKey: 'length.long', words: 400, min: 350, max: 450 },
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
    length: '',
    lengthAuto: '',
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
    const [base, presetNote, contextNote, length, lengthAuto, ...styleTexts] = await Promise.all([
        loadPromptFile(BASE_PROMPT_FILE),
        loadPromptFile(PRESET_NOTE_FILE),
        loadPromptFile(CONTEXT_NOTE_FILE),
        loadPromptFile(LENGTH_FILE),
        loadPromptFile(LENGTH_AUTO_FILE),
        ...SKALD_STYLES.map(style => loadPromptFile(style.promptFile)),
    ]);

    cache.base = base || FALLBACK_BASE;
    cache.presetNote = presetNote;
    cache.contextNote = contextNote;
    cache.length = length;
    cache.lengthAuto = lengthAuto;
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
 * Считает слова так же грубо, как это сделает человек: последовательности
 * букв и цифр. Разметка (*звёздочки*, тире, кавычки) в счёт не идёт.
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
    return String(text ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}

/**
 * План по длине для текущих настроек.
 * @param {number} draftWords сколько слов в черновике
 * @returns {{ target: number, min: number, max: number, paragraphs: number, draftWords: number }|null}
 *          null — режим «как в черновике»
 */
export function getLengthPlan(draftWords = 0) {
    const target = Math.max(0, Math.round(Number(getSettings().targetWords) || 0));
    if (!target) return null;

    // Попали в готовый пресет — берём его коридор, иначе ±20% вокруг цели.
    const preset = LENGTH_PRESETS.find(item => item.min && target >= item.min && target <= item.max);

    return {
        target,
        min: preset?.min ?? Math.round(target * 0.8),
        max: preset?.max ?? Math.round(target * 1.2),
        paragraphs: Math.max(1, Math.min(8, Math.round(target / 80))),
        draftWords,
    };
}

/**
 * Сколько токенов ответа стоит выдать под такую длину. Русский текст тяжелее
 * английского, поэтому запас щедрый: обрезанный на полуслове пост хуже,
 * чем неиспользованный лимит.
 * @param {ReturnType<typeof getLengthPlan>} plan
 * @returns {number} 0, если ограничение не нужно
 */
export function recommendedTokens(plan) {
    if (!plan) return 0;
    return Math.ceil((plan.max * 2.5) / 100) * 100;
}

/**
 * Слой длины: подставляет числа в prompts/length*.md.
 * Плейсхолдеры закрываются здесь, до substituteMacros, иначе таверна
 * попробует разобрать их как свои макросы.
 * @param {string} draftText
 * @returns {string}
 */
function buildLengthLayer(draftText) {
    const draftWords = countWords(draftText);
    const plan = getLengthPlan(draftWords);
    const template = plan ? cache.length : cache.lengthAuto;
    if (!template) return '';

    const values = {
        skaldr_draft_words: draftWords,
        skaldr_target: plan?.target ?? '',
        skaldr_min: plan?.min ?? '',
        skaldr_max: plan?.max ?? '',
        skaldr_paragraphs: plan?.paragraphs ?? '',
    };

    return template.replace(/\{\{(skaldr_\w+)\}\}/g, (whole, key) =>
        (Object.hasOwn(values, key) ? String(values[key]) : whole));
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
        buildLengthLayer(draftText),
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
