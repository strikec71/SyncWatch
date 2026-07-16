// Каталог быстрых сообщений (chatwheel) — единый источник истины (Фаза 0.7.0).
// По сети едет только `code`; получатель рендерит локализованный текст+эмодзи отсюда
// (неизвестный код молча игнорируется — forward-compat для новых фраз в новых версиях).
// Формулировки гендер-нейтральные. `autoPause` — фразы сценария «отойти»: у отправителя
// ставится ЛОКАЛЬНАЯ пауза, штатный STATE{pause} уходит комнате (пауза разрешена всем).

export interface QuickMessage {
  code: string;
  emoji: string;
  text: string;
  autoPause: boolean;
}

/** Порядок задаёт раскладку секторов колеса (8 штук, по кругу). */
export const QUICK_MESSAGES: readonly QuickMessage[] = [
  { code: 'brb-sec', emoji: '⏸️', text: 'Секундочку!', autoPause: true },
  { code: 'brb-away', emoji: '🚪', text: 'Надо отойти — скоро вернусь', autoPause: true },
  { code: 'brb-5min', emoji: '☕', text: 'Перерыв 5 минут', autoPause: true },
  { code: 'back', emoji: '▶️', text: 'На месте, можно продолжать', autoPause: false },
  { code: 'lag', emoji: '🐢', text: 'У меня подвисает — подождите', autoPause: false },
  { code: 'rewind', emoji: '↩️', text: 'Давайте отмотаем чуть назад', autoPause: false },
  { code: 'like', emoji: '👍', text: 'Класс!', autoPause: false },
  { code: 'lol', emoji: '😂', text: 'Ха-ха!', autoPause: false },
];

const BY_CODE: ReadonlyMap<string, QuickMessage> = new Map(
  QUICK_MESSAGES.map((m) => [m.code, m]),
);

/** Найти быструю фразу по коду (undefined для неизвестного — молчаливый форвард-compat). */
export function quickMessageByCode(code: string): QuickMessage | undefined {
  return BY_CODE.get(code);
}

/** Антиспам чата: не чаще одного сообщения в секунду (гейт и в UI, и в бэкграунде). */
export const CHAT_COOLDOWN_MS = 1000;

/** Сколько последних записей чата хранит лог сессии (переживает ремаунт островка). */
export const CHAT_LOG_MAX = 50;
