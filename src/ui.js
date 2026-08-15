/**
 * SKALDR — интерфейс: кнопка у поля ввода + плавающее окно с настройками.
 */

import { assetUrl, LOG_PREFIX, VERSION, ctx } from './constants.js';
import { getSettings, saveSettings, setSetting, CURRENT_API } from './settings.js';
import { t, applyI18n, initI18n } from './i18n.js';
import { SKALD_STYLES, getStyle, buildMessages, cleanResult } from './prompts.js';
import { getContextSummary } from './context.js';
import { getGroupedProfiles, isConnectionManagerAvailable, getProfile, requestRewrite, usesCurrentApi } from './connection.js';

const LAUNCHER_ID = 'skaldr_launcher';
const PANEL_ID = 'skaldr_panel';
const INPUT_SELECTOR = '#send_textarea';

/** Куда вешать кнопку запуска — строго по приоритету, первый существующий. */
const LAUNCHER_HOSTS = ['#leftSendForm', '#rightSendForm', '#send_form'];

const state = {
    panel: /** @type {HTMLElement|null} */ (null),
    busy: false,
    controller: /** @type {AbortController|null} */ (null),
    statusTimer: 0,
};

const els = {};

/* ------------------------------------------------------------------ */
/* Утилиты                                                             */
/* ------------------------------------------------------------------ */

/**
 * Ждёт появления элемента в DOM.
 * @param {string} selector
 * @param {number} [timeoutMs]
 * @returns {Promise<Element|null>}
 */
function waitForElement(selector, timeoutMs = 20000) {
    const existing = document.querySelector(selector);
    if (existing) return Promise.resolve(existing);

    return new Promise(resolve => {
        const observer = new MutationObserver(() => {
            const found = document.querySelector(selector);
            if (found) {
                observer.disconnect();
                clearTimeout(timer);
                resolve(found);
            }
        });

        const timer = setTimeout(() => {
            observer.disconnect();
            resolve(null);
        }, timeoutMs);

        observer.observe(document.body, { childList: true, subtree: true });
    });
}

/** @returns {HTMLTextAreaElement|null} поле ввода сообщения таверны */
function getInputField() {
    return document.querySelector(INPUT_SELECTOR);
}

/**
 * Пишет текст в поле ввода таверны так, чтобы ST об этом узнала
 * (авторазмер, сохранение черновика и т.д.).
 * @param {string} text
 * @returns {boolean}
 */
function writeToInput(text) {
    const input = getInputField();
    if (!input) return false;

    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

/**
 * @param {string} message
 * @param {'info'|'ok'|'warn'|'error'} [kind]
 */
function setStatus(message, kind = 'info') {
    if (!els.status) return;

    clearTimeout(state.statusTimer);
    els.status.textContent = message ?? '';
    els.status.className = `skaldr-status skaldr-status-${kind}`;

    if (message && kind !== 'error') {
        state.statusTimer = setTimeout(() => {
            if (els.status.textContent === message) {
                els.status.textContent = '';
                els.status.className = 'skaldr-status';
            }
        }, 6000);
    }
}

/* ------------------------------------------------------------------ */
/* Кнопка у поля ввода                                                 */
/* ------------------------------------------------------------------ */

/**
 * Ищет контейнер для кнопки. querySelector со списком селекторов вернул бы первый
 * элемент по порядку в документе (а #send_form — предок остальных), поэтому
 * приоритет перебираем руками.
 * @returns {Promise<Element|null>}
 */
async function findLauncherHost() {
    const pick = () => LAUNCHER_HOSTS.reduce(
        (found, selector) => found ?? document.querySelector(selector),
        null,
    );

    const immediate = pick();
    if (immediate) return immediate;

    const appeared = await waitForElement(LAUNCHER_HOSTS.join(', '));
    return appeared ? (pick() ?? appeared) : null;
}

async function injectLauncher() {
    if (document.getElementById(LAUNCHER_ID)) return;

    const host = await findLauncherHost();
    if (!host) {
        console.warn(`${LOG_PREFIX} не найден контейнер поля ввода, кнопка не добавлена`);
        return;
    }

    const button = document.createElement('div');
    button.id = LAUNCHER_ID;
    button.className = 'fa-solid fa-feather-pointed interactable skaldr-launcher';
    button.tabIndex = 0;
    button.title = t('launcher.tooltip');
    button.setAttribute('role', 'button');

    button.addEventListener('click', () => void togglePanel());
    button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void togglePanel();
        }
    });

    host.append(button);
}

/* ------------------------------------------------------------------ */
/* Окно                                                                */
/* ------------------------------------------------------------------ */

async function buildPanel() {
    if (state.panel) return state.panel;

    const response = await fetch(assetUrl('templates/panel.html'));
    if (!response.ok) throw new Error(`не удалось загрузить шаблон окна: HTTP ${response.status}`);

    const holder = document.createElement('div');
    holder.innerHTML = await response.text();

    const panel = holder.querySelector(`#${PANEL_ID}`);
    if (!panel) throw new Error('в шаблоне окна нет #skaldr_panel');

    document.body.append(panel);
    state.panel = panel;

    els.viewMain = panel.querySelector('[data-skaldr-view="main"]');
    els.viewSettings = panel.querySelector('[data-skaldr-view="settings"]');
    els.styles = panel.querySelector('[data-skaldr-styles]');
    els.source = panel.querySelector('[data-skaldr-source]');
    els.result = panel.querySelector('[data-skaldr-result]');
    els.status = panel.querySelector('[data-skaldr-status]');
    els.generate = panel.querySelector('[data-skaldr-action="generate"]');
    els.apply = panel.querySelector('[data-skaldr-action="apply"]');
    els.connection = panel.querySelector('[data-skaldr-connection]');
    els.connectionWarn = panel.querySelector('[data-skaldr-connection-warn]');
    els.toggles = [...panel.querySelectorAll('[data-skaldr-toggle]')];
    els.depthRow = panel.querySelector('[data-skaldr-depth-row]');
    els.chatDepth = panel.querySelector('[data-skaldr-chat-depth]');
    els.contextSummary = panel.querySelector('[data-skaldr-context-summary]');
    els.maxTokens = panel.querySelector('[data-skaldr-max-tokens]');
    els.autoPull = panel.querySelector('[data-skaldr-auto-pull]');
    els.closeAfterApply = panel.querySelector('[data-skaldr-close-after-apply]');
    els.language = panel.querySelector('[data-skaldr-language]');
    els.version = panel.querySelector('[data-skaldr-version]');

    applyI18n(panel);
    renderStyles();
    renderSettingsView();
    bindPanelEvents(panel);
    makeDraggable(panel);

    if (els.version) els.version.textContent = `v${VERSION}`;

    return panel;
}

function renderStyles() {
    if (!els.styles) return;

    const settings = getSettings();
    els.styles.innerHTML = '';

    for (const style of SKALD_STYLES) {
        const card = document.createElement('div');
        card.className = 'skaldr-style';
        card.dataset.styleId = style.id;
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.classList.toggle('selected', style.id === settings.style);

        const icon = document.createElement('i');
        icon.className = style.icon;

        const texts = document.createElement('div');
        texts.className = 'skaldr-style-texts';

        const name = document.createElement('div');
        name.className = 'skaldr-style-name';
        name.textContent = t(style.nameKey);

        const desc = document.createElement('div');
        desc.className = 'skaldr-style-desc';
        desc.textContent = t(style.descKey);

        texts.append(name, desc);
        card.append(icon, texts);

        const select = () => selectStyle(style.id);
        card.addEventListener('click', select);
        card.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                select();
            }
        });

        els.styles.append(card);
    }
}

/** @param {string} styleId */
function selectStyle(styleId) {
    setSetting('style', styleId);
    for (const card of els.styles.querySelectorAll('.skaldr-style')) {
        card.classList.toggle('selected', card.dataset.styleId === styleId);
    }
}

function renderConnectionSelect() {
    if (!els.connection) return;

    const settings = getSettings();
    const select = els.connection;
    select.innerHTML = '';

    const currentOption = document.createElement('option');
    currentOption.value = CURRENT_API;
    currentOption.textContent = t('settings.currentApi');
    select.append(currentOption);

    const managerAvailable = isConnectionManagerAvailable();
    if (managerAvailable) {
        for (const group of getGroupedProfiles()) {
            const container = group.label
                ? Object.assign(document.createElement('optgroup'), { label: group.label })
                : select;

            for (const profile of group.profiles) {
                const option = document.createElement('option');
                option.value = profile.id;
                option.textContent = profile.name ?? profile.id;
                container.append(option);
            }

            if (container !== select) select.append(container);
        }
    }

    // Профиль мог быть удалён между сессиями — тогда честно откатываемся на текущий API.
    const wanted = settings.connectionProfile;
    if (wanted && !getProfile(wanted)) {
        settings.connectionProfile = CURRENT_API;
        saveSettings();
    }
    select.value = settings.connectionProfile || CURRENT_API;

    if (els.connectionWarn) {
        const showWarning = !managerAvailable;
        els.connectionWarn.classList.toggle('skaldr-hidden', !showWarning);
        if (showWarning) els.connectionWarn.textContent = t('settings.cmDisabled');
    }
}

function renderToggles() {
    const settings = getSettings();

    for (const toggle of els.toggles ?? []) {
        const key = toggle.dataset.skaldrToggle;
        const on = !!settings[key];
        toggle.classList.toggle('on', on);
        toggle.setAttribute('aria-pressed', String(on));
    }

    els.depthRow?.classList.toggle('skaldr-disabled', !settings.useChat);
    if (els.chatDepth) els.chatDepth.value = String(settings.chatDepth);
}

/**
 * Подпись под тумблерами: что именно уйдёт в SKALDR.
 * Чат сюда не пишем — у него своя настройка глубины рядом.
 */
async function renderContextSummary() {
    if (!els.contextSummary) return;

    let summary;
    try {
        summary = await getContextSummary();
    } catch (error) {
        console.warn(`${LOG_PREFIX} сводку контекста собрать не удалось:`, error);
        return;
    }

    const rows = [];
    const push = (labelKey, value, ok) => rows.push({ label: t(labelKey), value, ok });

    if (summary.preset) {
        const name = summary.preset.name;
        push('settings.usePreset',
            name && !summary.preset.empty ? name : t(summary.preset.empty ? 'summary.presetEmpty' : 'summary.none'),
            !!name && !summary.preset.empty);
    }
    if (summary.persona) {
        push('settings.usePersona', summary.persona.name || t('summary.none'), !!summary.persona.name);
    }
    if (summary.character) {
        push('settings.useCharacter', summary.character.name || t('summary.noChat'), !!summary.character.name);
    }
    if (summary.lorebook) {
        const names = summary.lorebook.names;
        push('settings.useLorebook', names.length ? names.join(', ') : t('summary.noBooks'), names.length > 0);
    }

    els.contextSummary.innerHTML = '';
    if (!rows.length) {
        els.contextSummary.classList.add('skaldr-hidden');
        return;
    }

    els.contextSummary.classList.remove('skaldr-hidden');
    for (const row of rows) {
        const line = document.createElement('div');
        line.className = `skaldr-summary-row${row.ok ? '' : ' missing'}`;

        const label = document.createElement('span');
        label.className = 'skaldr-summary-label';
        label.textContent = `${row.label}:`;

        const value = document.createElement('span');
        value.className = 'skaldr-summary-value';
        value.textContent = row.value;

        line.append(label, value);
        els.contextSummary.append(line);
    }
}

function renderSettingsView() {
    const settings = getSettings();

    renderConnectionSelect();
    renderToggles();
    void renderContextSummary();
    if (els.maxTokens) els.maxTokens.value = String(settings.maxTokens);
    if (els.autoPull) els.autoPull.checked = !!settings.autoPull;
    if (els.closeAfterApply) els.closeAfterApply.checked = !!settings.closeAfterApply;
    if (els.language) els.language.value = settings.language ?? 'auto';
}

/** @param {HTMLElement} panel */
function bindPanelEvents(panel) {
    panel.addEventListener('click', event => {
        const toggle = event.target.closest('[data-skaldr-toggle]');
        if (toggle && panel.contains(toggle)) {
            flipToggle(toggle.dataset.skaldrToggle);
            return;
        }

        const trigger = event.target.closest('[data-skaldr-action]');
        if (!trigger || !panel.contains(trigger)) return;
        handleAction(trigger.dataset.skaldrAction);
    });

    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            closePanel();
            return;
        }

        if (event.key !== 'Enter' && event.key !== ' ') return;

        const toggle = event.target.closest?.('[data-skaldr-toggle]');
        if (toggle) {
            event.preventDefault();
            flipToggle(toggle.dataset.skaldrToggle);
            return;
        }

        const trigger = event.target.closest?.('[data-skaldr-action]');
        if (trigger) {
            event.preventDefault();
            handleAction(trigger.dataset.skaldrAction);
        }
    });

    els.chatDepth?.addEventListener('change', () => {
        const value = Math.max(1, Math.min(200, Number(els.chatDepth.value) || 10));
        els.chatDepth.value = String(value);
        setSetting('chatDepth', value);
    });

    // Ctrl/Cmd+Enter в исходнике — сразу переписать.
    els.source?.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            void onGenerate();
        }
    });

    els.connection?.addEventListener('change', () => {
        setSetting('connectionProfile', els.connection.value);
    });

    els.maxTokens?.addEventListener('change', () => {
        const value = Math.max(16, Math.min(32768, Number(els.maxTokens.value) || 1024));
        els.maxTokens.value = String(value);
        setSetting('maxTokens', value);
    });

    els.autoPull?.addEventListener('change', () => setSetting('autoPull', els.autoPull.checked));
    els.closeAfterApply?.addEventListener('change', () => setSetting('closeAfterApply', els.closeAfterApply.checked));

    els.language?.addEventListener('change', async () => {
        setSetting('language', els.language.value);
        await initI18n();
        applyI18n(panel);
        renderStyles();
        renderSettingsView();
        setBusy(state.busy);
        const launcher = document.getElementById(LAUNCHER_ID);
        if (launcher) launcher.title = t('launcher.tooltip');
    });

    // Профили и контекст могли измениться в другом месте интерфейса.
    const context = ctx();
    const events = context?.eventTypes ?? context?.event_types;
    if (context?.eventSource && events) {
        for (const key of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED']) {
            const eventName = events[key];
            if (eventName) context.eventSource.on(eventName, () => renderConnectionSelect());
        }

        // Сводку пересобираем только когда вид настроек открыт: SETTINGS_UPDATED
        // в таверне летит часто, дёргать сбор контекста вхолостую незачем.
        const refreshSummaryIfVisible = () => {
            if (els.viewSettings && !els.viewSettings.classList.contains('skaldr-hidden')) {
                void renderContextSummary();
            }
        };
        for (const key of ['CHAT_CHANGED', 'SETTINGS_UPDATED', 'WORLDINFO_UPDATED']) {
            const eventName = events[key];
            if (eventName) context.eventSource.on(eventName, refreshSummaryIfVisible);
        }
    }

    window.addEventListener('resize', () => clampIntoViewport(panel));
}

/**
 * Переключает тумблер контекста.
 * @param {string} key ключ настройки
 */
function flipToggle(key) {
    if (!key || !Object.hasOwn(getSettings(), key)) return;

    setSetting(key, !getSettings()[key]);
    renderToggles();
    void renderContextSummary();
}

/** @param {string} action */
function handleAction(action) {
    switch (action) {
        case 'close': closePanel(); break;
        case 'toggle-settings': toggleSettingsView(); break;
        case 'pull': pullFromInput(true); break;
        case 'copy': void copyResult(); break;
        case 'generate': void onGenerate(); break;
        case 'apply': applyResult(); break;
        case 'refresh-profiles': renderConnectionSelect(); setStatus(t('status.profilesRefreshed'), 'ok'); break;
        case 'reset-position': resetPosition(); break;
        default: break;
    }
}

function toggleSettingsView() {
    if (!els.viewMain || !els.viewSettings) return;

    const showSettings = els.viewSettings.classList.contains('skaldr-hidden');
    if (showSettings) renderSettingsView();

    els.viewSettings.classList.toggle('skaldr-hidden', !showSettings);
    els.viewMain.classList.toggle('skaldr-hidden', showSettings);
}

/* ------------------------------------------------------------------ */
/* Перетаскивание и позиция                                            */
/* ------------------------------------------------------------------ */

/** @param {HTMLElement} panel */
function makeDraggable(panel) {
    const handle = panel.querySelector('[data-skaldr-drag]');
    if (!handle) return;

    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let dragging = false;

    handle.addEventListener('pointerdown', event => {
        if (event.target.closest('[data-skaldr-action]')) return;
        if (event.button !== 0 && event.pointerType === 'mouse') return;

        const rect = panel.getBoundingClientRect();
        startX = event.clientX;
        startY = event.clientY;
        originLeft = rect.left;
        originTop = rect.top;
        dragging = true;

        panel.classList.add('skaldr-dragging');
        handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener('pointermove', event => {
        if (!dragging) return;
        event.preventDefault();
        setPosition(panel, originLeft + (event.clientX - startX), originTop + (event.clientY - startY));
    });

    const stop = event => {
        if (!dragging) return;
        dragging = false;
        panel.classList.remove('skaldr-dragging');
        try {
            handle.releasePointerCapture(event.pointerId);
        } catch {
            /* пофиг, указатель уже отпущен */
        }

        const rect = panel.getBoundingClientRect();
        setSetting('panelPos', { left: Math.round(rect.left), top: Math.round(rect.top) });
    };

    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
}

/**
 * @param {HTMLElement} panel
 * @param {number} left
 * @param {number} top
 */
function setPosition(panel, left, top) {
    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);

    panel.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
    panel.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
}

/** @param {HTMLElement} panel */
function clampIntoViewport(panel) {
    if (!panel || panel.classList.contains('skaldr-hidden')) return;
    const rect = panel.getBoundingClientRect();
    setPosition(panel, rect.left, rect.top);
}

/** @param {HTMLElement} panel */
function restorePosition(panel) {
    const saved = getSettings().panelPos;
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        setPosition(panel, saved.left, saved.top);
        return;
    }

    // По умолчанию — над кнопкой запуска, по центру, если кнопки нет.
    const rect = panel.getBoundingClientRect();
    const launcher = document.getElementById(LAUNCHER_ID);
    const anchor = launcher?.getBoundingClientRect();

    const left = anchor
        ? anchor.left + anchor.width / 2 - rect.width / 2
        : (window.innerWidth - rect.width) / 2;
    const top = anchor
        ? anchor.top - rect.height - 12
        : (window.innerHeight - rect.height) / 2;

    setPosition(panel, left, top);
}

function resetPosition() {
    setSetting('panelPos', null);
    if (state.panel) restorePosition(state.panel);
    setStatus(t('status.positionReset'), 'ok');
}

/* ------------------------------------------------------------------ */
/* Действия                                                            */
/* ------------------------------------------------------------------ */

/** @param {boolean} [notify] показывать ли статус */
function pullFromInput(notify = false) {
    const input = getInputField();
    if (!input) {
        if (notify) setStatus(t('status.noInput'), 'warn');
        return;
    }

    els.source.value = input.value ?? '';
    if (notify) setStatus(t('status.pulled'), 'ok');
}

async function copyResult() {
    const text = els.result?.value ?? '';
    if (!text.trim()) {
        setStatus(t('status.emptyResult'), 'warn');
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        setStatus(t('status.copied'), 'ok');
    } catch (error) {
        console.warn(`${LOG_PREFIX} копирование не удалось:`, error);
        els.result.select();
        setStatus(t('status.copyFailed'), 'warn');
    }
}

/** @param {boolean} busy */
function setBusy(busy) {
    state.busy = busy;
    if (!els.generate) return;

    const icon = els.generate.querySelector('i');
    const label = els.generate.querySelector('[data-skaldr-btn-label]');

    els.generate.classList.toggle('skaldr-busy', busy);
    if (icon) icon.className = busy ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-fire-flame-curved';
    if (label) label.textContent = busy ? t('main.stop') : t('main.skal');
    els.apply?.classList.toggle('skaldr-disabled', busy);
}

function abortGeneration() {
    state.controller?.abort();
    if (usesCurrentApi()) {
        try {
            ctx()?.stopGeneration?.();
        } catch (error) {
            console.warn(`${LOG_PREFIX} stopGeneration не сработал:`, error);
        }
    }
}

async function onGenerate() {
    if (state.busy) {
        abortGeneration();
        return;
    }

    const text = (els.source?.value ?? '').trim();
    if (!text) {
        setStatus(t('status.emptySource'), 'warn');
        els.source?.focus();
        return;
    }

    const settings = getSettings();
    const style = getStyle(settings.style);

    state.controller = new AbortController();
    setBusy(true);
    setStatus(t('status.working', { style: t(style.nameKey) }), 'info');

    try {
        const messages = await buildMessages(settings.style, text);
        console.debug(`${LOG_PREFIX} системный промпт: ${messages[0]?.content?.length ?? 0} символов`);

        const raw = await requestRewrite({ messages, signal: state.controller.signal });
        const result = cleanResult(raw);

        if (!result) throw new Error(t('status.emptyResponse'));

        els.result.value = result;
        setStatus(t('status.done'), 'ok');
    } catch (error) {
        if (error?.name === 'AbortError' || state.controller?.signal.aborted) {
            setStatus(t('status.aborted'), 'warn');
        } else {
            console.error(`${LOG_PREFIX} запрос не удался:`, error);
            const cause = error?.cause?.message ?? error?.message ?? String(error);
            setStatus(t('status.error', { msg: cause }), 'error');
        }
    } finally {
        state.controller = null;
        setBusy(false);
    }
}

function applyResult() {
    if (state.busy) return;

    const text = (els.result?.value ?? '').trim();
    if (!text) {
        setStatus(t('status.emptyResult'), 'warn');
        return;
    }

    if (!writeToInput(text)) {
        setStatus(t('status.noInput'), 'error');
        return;
    }

    setStatus(t('status.applied'), 'ok');
    if (getSettings().closeAfterApply) closePanel();
}

/* ------------------------------------------------------------------ */
/* Открытие / закрытие                                                 */
/* ------------------------------------------------------------------ */

/** @param {string} [presetText] текст, которым сразу заполнить исходник */
export async function openPanel(presetText) {
    const panel = await buildPanel();

    panel.classList.remove('skaldr-hidden');
    restorePosition(panel);

    if (typeof presetText === 'string' && presetText.length) {
        els.source.value = presetText;
    } else if (getSettings().autoPull) {
        pullFromInput(false);
    }

    els.source?.focus();
}

export function closePanel() {
    state.panel?.classList.add('skaldr-hidden');
}

export async function togglePanel() {
    if (state.panel && !state.panel.classList.contains('skaldr-hidden')) {
        closePanel();
        return;
    }
    await openPanel();
}

/* ------------------------------------------------------------------ */
/* Инициализация                                                       */
/* ------------------------------------------------------------------ */

export async function initUi() {
    await injectLauncher();
}
