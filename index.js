/**
 * SKALDR — переписывание текста из поля ввода в скальдическом духе.
 *
 * Точка входа: подключает настройки, локализацию, интерфейс и слэш-команду.
 * Вся логика разложена по src/.
 */

import { LOG_PREFIX, VERSION, ctx } from './src/constants.js';
import { initSettings } from './src/settings.js';
import { initI18n, t } from './src/i18n.js';
import { initPrompts } from './src/prompts.js';
import { initUi, openPanel, togglePanel } from './src/ui.js';

/** Регистрирует /skaldr — открыть окно (опционально сразу с текстом). */
function registerSlashCommand() {
    const context = ctx();
    const SlashCommandParser = context?.SlashCommandParser;
    const SlashCommand = context?.SlashCommand;
    const SlashCommandArgument = context?.SlashCommandArgument;
    const ARGUMENT_TYPE = context?.ARGUMENT_TYPE;

    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) {
        console.warn(`${LOG_PREFIX} API слэш-команд недоступен, /skaldr не зарегистрирован`);
        return;
    }

    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'skaldr',
            callback: async (_namedArgs, unnamedArg) => {
                const text = Array.isArray(unnamedArg) ? unnamedArg.join(' ') : String(unnamedArg ?? '');
                if (text.trim()) {
                    await openPanel(text);
                } else {
                    await togglePanel();
                }
                return '';
            },
            unnamedArgumentList: SlashCommandArgument?.fromProps
                ? [SlashCommandArgument.fromProps({
                    description: t('slash.textArg'),
                    typeList: ARGUMENT_TYPE?.STRING ? [ARGUMENT_TYPE.STRING] : [],
                    isRequired: false,
                })]
                : [],
            helpString: t('slash.help'),
        }));
    } catch (error) {
        console.warn(`${LOG_PREFIX} не удалось зарегистрировать /skaldr:`, error);
    }
}

async function init() {
    try {
        initSettings();
        await Promise.all([initI18n(), initPrompts()]);
        await initUi();
        registerSlashCommand();
        console.log(`${LOG_PREFIX} v${VERSION} готов`);
    } catch (error) {
        console.error(`${LOG_PREFIX} инициализация провалилась:`, error);
    }
}

if (globalThis.jQuery) {
    globalThis.jQuery(() => void init());
} else {
    globalThis.addEventListener('DOMContentLoaded', () => void init(), { once: true });
}
