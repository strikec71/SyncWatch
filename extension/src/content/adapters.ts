// Сайт-специфичные оверрайды детекта плеера (Фаза 3).
// Универсальная эвристика в player.ts покрывает большинство сайтов; адаптеры нужны там,
// где несколько <video> сбивают выбор, плеер в shadow DOM или его надо взять по селектору.
// Адаптер возвращает null → откат к универсальной эвристике (мягкая деградация).

/** Выбор контента внутри плеера (Фаза 3): серия/сезон/озвучка. `sig` — каноническая
 *  подпись, ОДИНАКОВАЯ у всех участников на одном тайтле (числа/id, без per-machine хэшей);
 *  `human` — для ленты островка. */
export interface ContentSelection {
  sig: string;
  human: string;
}

export interface SiteAdapter {
  name: string;
  /** Матч по хосту И/ИЛИ по сигнатуре DOM (для iframe пиратских балансеров домен неизвестен). */
  matches(host: string, doc: Document): boolean;
  /** Вернуть канонический <video> сайта или null для отката к универсальному поиску. */
  pick(doc: Document): HTMLVideoElement | null;
  /** Идёт ли сейчас реклама (для sync-aware поведения). Не задан → реклама не детектится. */
  isAd?(doc: Document): boolean;
  /** Текущий выбор серии/сезона/озвучки (Фаза 3). null → плеер не готов/не сериал. */
  getSelection?(doc: Document): ContentSelection | null;
  /** Применить выбор партнёра. Драйвим родной UI плеера (для Kodik — нативные <select>),
   *  чтобы он сам сменил источник. Не задан → синхрон выбора для сайта не поддержан.
   *  `onDone` (если передан) вызывается ровно раз: `true` при достижении выбора, `false` по
   *  исчерпании ретраев (такой серии/озвучки в нашем плеере нет — наборы различаются). */
  applySelection?(sig: string, doc: Document, onDone?: (ok: boolean) => void): void;
}

const YOUTUBE: SiteAdapter = {
  name: 'youtube',
  matches: (host) => /(^|\.)youtube(-nocookie)?\.com$/.test(host),
  // YouTube переиспользует один <video> и для рекламы, и для контента — берём его по классу.
  pick: (doc) => doc.querySelector<HTMLVideoElement>('.html5-main-video, video.video-stream'),
  // Во время рекламы плеер получает класс .ad-showing / .ad-interrupting.
  isAd: (doc) => !!doc.querySelector('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting'),
};

const JUTSU: SiteAdapter = {
  name: 'jut.su',
  matches: (host) => /(^|\.)jut\.su$/.test(host) || /(^|\.)jut-su\.net$/.test(host),
  pick: (doc) => doc.querySelector<HTMLVideoElement>('#my-player video, .vjs-tech'),
};

// PlayerJS / Video.js — типовой плеер «балансеров» (Kinogo, smotvibe и пр.) в кросс-доменных
// iframe. Матчим по сигнатуре DOM, т.к. домен iframe заранее не известен.
const PLAYERJS: SiteAdapter = {
  name: 'playerjs',
  matches: (_host, doc) =>
    !!doc.querySelector('#oframecdnplayer, [id*="cdnplayer"], .video-js, #player .vjs-tech'),
  pick: (doc) =>
    doc.querySelector<HTMLVideoElement>(
      '#oframecdnplayer video, [id*="cdnplayer"] video, .video-js video, .vjs-tech',
    ),
};

// ── Kodik-балансер (Фаза 3): серия/сезон/озвучка внутри iframe ────────────────
// jut-su.net (и др.) грузят Kodik в кросс-доменный iframe; наш content-script работает
// и там (all_frames). Kodik держит выбор в нативных <select> внутри `.serial-panel` и сам
// вешает на них `change` — поэтому переключаем, выставляя `value` + диспатча `change`
// (Kodik меняет источник НА МЕСТЕ, без смены URL). См. syncwatch-kodik-player (memory).

type KodikSel = { season: string | null; episode: string | null; translation: string | null };

/** Собрать каноническую подпись из выбранных значений (числа/id — стабильны между машинами).
 *  Порядок фиксирован s|e|t; отсутствующие измерения опускаем (у фильмов нет серий/сезонов). */
export function kodikBuildSig(sel: KodikSel): string | null {
  const parts: string[] = [];
  if (sel.season) parts.push(`s=${sel.season}`);
  if (sel.episode) parts.push(`e=${sel.episode}`);
  if (sel.translation) parts.push(`t=${sel.translation}`);
  if (parts.length === 0) return null; // ни одного измерения — плеер не готов
  return `kodik|${parts.join('|')}`;
}

/** Разобрать подпись обратно в измерения (для применения). Чужой префикс → null. */
export function kodikParseSig(sig: string): KodikSel | null {
  const parts = sig.split('|');
  if (parts[0] !== 'kodik') return null;
  const out: KodikSel = { season: null, episode: null, translation: null };
  for (const p of parts.slice(1)) {
    const [k, v] = p.split('=');
    if (!v) continue;
    if (k === 's') out.season = v;
    else if (k === 'e') out.episode = v;
    else if (k === 't') out.translation = v;
  }
  return out;
}

/** Значение выбранной опции нативного <select> по CSS-селектору бокса (или null). */
function selectedVal(doc: Document, boxSel: string): string | null {
  const sel = doc.querySelector<HTMLSelectElement>(`${boxSel} select`);
  const v = sel?.value;
  return v != null && v !== '' ? v : null;
}

function kodikRead(doc: Document): KodikSel {
  return {
    season: selectedVal(doc, '.serial-seasons-box'),
    episode: selectedVal(doc, '.serial-series-box'),
    // У фильмов бокс называется .movie-translations-box.
    translation: selectedVal(doc, '.serial-translations-box') ?? selectedVal(doc, '.movie-translations-box'),
  };
}

/** Человекочитаемая подпись из data-title выбранных опций (для ленты островка). */
function kodikHuman(doc: Document): string {
  const title = (boxSel: string): string | null => {
    const opt = doc.querySelector<HTMLOptionElement>(`${boxSel} select option:checked`);
    return opt?.dataset.title || opt?.textContent?.trim() || null;
  };
  const bits = [
    title('.serial-seasons-box'),
    title('.serial-series-box'),
    title('.serial-translations-box') ?? title('.movie-translations-box'),
  ].filter(Boolean);
  return bits.join(' · ') || 'серия';
}

/** Выставить <select> на значение и дёрнуть родной обработчик Kodik (nativeChange). */
function driveSelect(doc: Document, boxSel: string, value: string): void {
  const sel = doc.querySelector<HTMLSelectElement>(`${boxSel} select`);
  if (!sel || sel.value === value) return; // нет бокса или уже на нужном — не трогаем
  const opt = sel.querySelector<HTMLOptionElement>(`option[value="${CSS.escape(value)}"]`);
  if (!opt) return; // такой серии/озвучки в текущем списке пока нет (репопуляция ещё не дошла)
  sel.value = value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

// Смена озвучки/сезона в Kodik асинхронно перестраивает списки серий — применяем
// поэтапно с несколькими повторами; частый кейс «сменилась только серия» отработает сразу.
const KODIK_APPLY_RETRIES = 6;
const KODIK_APPLY_INTERVAL_MS = 400;

const KODIK: SiteAdapter = {
  name: 'kodik',
  matches: (host, doc) =>
    /(^|\.)(kodik(player)?|aniqit|anivod)\.[a-z]+$/.test(host) ||
    !!doc.querySelector('.serial-panel .serial-series-box, .serial-panel .serial-translations-box, .movie-translations-box'),
  pick: (doc) => doc.querySelector<HTMLVideoElement>('video'),
  getSelection: (doc) => {
    const sel = kodikRead(doc);
    const sig = kodikBuildSig(sel);
    return sig ? { sig, human: kodikHuman(doc) } : null;
  },
  applySelection: (sig, doc, onDone) => {
    const want = kodikParseSig(sig);
    if (!want) { onDone?.(false); return; }
    let left = KODIK_APPLY_RETRIES;
    const step = (): void => {
      // Порядок важен: озвучка → сезон → серия (каждое перестраивает следующий список).
      if (want.translation) driveSelect(doc, '.serial-translations-box', want.translation);
      if (want.translation) driveSelect(doc, '.movie-translations-box', want.translation);
      if (want.season) driveSelect(doc, '.serial-seasons-box', want.season);
      if (want.episode) driveSelect(doc, '.serial-series-box', want.episode);
      const now = kodikRead(doc);
      const done =
        (!want.season || now.season === want.season) &&
        (!want.episode || now.episode === want.episode) &&
        (!want.translation || now.translation === want.translation);
      if (done) { onDone?.(true); return; }
      if (--left > 0) setTimeout(step, KODIK_APPLY_INTERVAL_MS);
      else onDone?.(false); // такой серии/озвучки в нашем плеере нет — сигнализируем хабу
    };
    step();
  },
};

// ── Alloha-балансер (пункт 5 фиксов): «основной плеер» jut-su.net и др. ────────
// jut-su.net грузит Alloha в кросс-доменный iframe (ротируемое зеркало — домен случайный,
// матчим ТОЛЬКО по DOM). Серию/сезон/озвучку меняют кастомные дропдауны (НЕ <select>):
// `.select[data-select^="…"] .select__drop-item[data-id]`, активный — класс `active`.
// Плеер сам переключает серии кликом по `.select__drop-item` (делегированный хендлер) —
// источник меняется НА МЕСТЕ из инлайн-модели, без навигации iframe. Драйвим тем же кликом.
// data-id: сезон/серия — числа; озвучка — `t<ID>` (в подписи храним числовой хвост).
// Детали: memory syncwatch-jutsu-alloha.

type AllohaSel = { season: string | null; episode: string | null; translation: string | null };

/** Подпись выбора Alloha (числа/id — стабильны между машинами). Порядок s|e|t; отсутствующие
 *  измерения опускаем (фильмы: только озвучка). Зеркалит формат Kodik со своим префиксом. */
export function allohaBuildSig(sel: AllohaSel): string | null {
  const parts: string[] = [];
  if (sel.season) parts.push(`s=${sel.season}`);
  if (sel.episode) parts.push(`e=${sel.episode}`);
  if (sel.translation) parts.push(`t=${sel.translation}`);
  if (parts.length === 0) return null; // ни одного измерения — плеер не готов
  return `alloha|${parts.join('|')}`;
}

/** Разобрать подпись Alloha обратно в измерения. Чужой префикс → null. */
export function allohaParseSig(sig: string): AllohaSel | null {
  const parts = sig.split('|');
  if (parts[0] !== 'alloha') return null;
  const out: AllohaSel = { season: null, episode: null, translation: null };
  for (const p of parts.slice(1)) {
    const [k, v] = p.split('=');
    if (!v) continue;
    if (k === 's') out.season = v;
    else if (k === 'e') out.episode = v;
    else if (k === 't') out.translation = v;
  }
  return out;
}

/** data-id активного пункта дропдауна (`.select__drop-item.active`) в боксе, или null. */
function allohaActiveId(doc: Document, boxSel: string): string | null {
  const el = doc.querySelector<HTMLElement>(`${boxSel} .select__drop-item.active`);
  const id = el?.getAttribute('data-id');
  return id != null && id !== '' ? id : null;
}

function allohaRead(doc: Document): AllohaSel {
  const t = allohaActiveId(doc, '[data-select^="translation"]');
  return {
    season: allohaActiveId(doc, '[data-select^="season"]'),
    episode: allohaActiveId(doc, '[data-select^="episode"]'),
    translation: t ? t.replace(/^t/, '') : null, // 't10' → '10' (в подписи — числовой хвост)
  };
}

/** Человекочитаемая подпись из текстов выбранных пунктов (`.select__item-text`). */
function allohaHuman(doc: Document): string {
  const text = (boxSel: string): string | null =>
    doc.querySelector<HTMLElement>(`${boxSel} .select__item-text`)?.textContent?.trim() || null;
  const bits = [
    text('[data-select^="season"]'),
    text('[data-select^="episode"]'),
    text('[data-select^="translation"]'),
  ].filter(Boolean);
  return bits.join(' · ') || 'серия';
}

/** Нативный клик по пункту с фолбэком полной последовательностью: делегированный хендлер
 *  Alloha может слушать pointerdown/mousedown, а не click — шлём весь ряд, завершая одиночным
 *  el.click() (без дубля click-события). Runtime-риск №1 плана — проверяется живьём. */
function allohaClickItem(el: HTMLElement): void {
  for (const type of ['pointerdown', 'mousedown', 'mouseup'] as const) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  }
  el.click();
}

/** Кликнуть пункт с нужным data-id в боксе (если он есть и ещё не активен). */
function allohaDrive(doc: Document, boxSel: string, dataId: string): void {
  const box = doc.querySelector(boxSel);
  if (!box) return;
  const item = box.querySelector<HTMLElement>(`.select__drop-item[data-id="${CSS.escape(dataId)}"]`);
  if (!item) return; // список ещё не перестроен (репопуляция после смены сезона/озвучки не дошла)
  if (item.classList.contains('active')) return; // уже выбран — не дёргаем
  allohaClickItem(item);
}

// Смена озвучки/сезона перестраивает список серий асинхронно (`.baron__scroller` empty→append) —
// применяем поэтапно с повторами, как у Kodik.
const ALLOHA_APPLY_RETRIES = 6;
const ALLOHA_APPLY_INTERVAL_MS = 400;

const ALLOHA: SiteAdapter = {
  name: 'alloha',
  // ТОЛЬКО DOM-сигнатура (домен зеркала ротируется). Требуем И селект-дропдаун, И наш
  // контент-video, чтобы не зацепить чужие плееры.
  matches: (_host, doc) =>
    !!doc.querySelector('[data-select^="episodeType"], [data-select^="seasonType"], [data-select^="translation"]')
    && !!doc.querySelector('video#player'),
  // Пиновать контент-video: универсальная эвристика во время преролла схватила бы РЕКЛАМНОЕ
  // видео rmp-vast (`.rmp-ad-container video`).
  pick: (doc) => doc.querySelector<HTMLVideoElement>('video#player'),
  getSelection: (doc) => {
    const sel = allohaRead(doc);
    const sig = allohaBuildSig(sel);
    return sig ? { sig, human: allohaHuman(doc) } : null;
  },
  applySelection: (sig, doc, onDone) => {
    const want = allohaParseSig(sig);
    if (!want) { onDone?.(false); return; }
    let left = ALLOHA_APPLY_RETRIES;
    const step = (): void => {
      // Порядок: озвучка → сезон → серия (каждое перестраивает следующий список). Озвучка —
      // data-id с префиксом `t`.
      if (want.translation) allohaDrive(doc, '[data-select^="translation"]', `t${want.translation}`);
      if (want.season) allohaDrive(doc, '[data-select^="season"]', want.season);
      if (want.episode) allohaDrive(doc, '[data-select^="episode"]', want.episode);
      const now = allohaRead(doc);
      const done =
        (!want.season || now.season === want.season) &&
        (!want.episode || now.episode === want.episode) &&
        (!want.translation || now.translation === want.translation);
      if (done) { onDone?.(true); return; }
      if (--left > 0) setTimeout(step, ALLOHA_APPLY_INTERVAL_MS);
      else onDone?.(false); // такой озвучки/серии в нашем плеере нет — сигнализируем хабу
    };
    step();
  },
};

const ADAPTERS: SiteAdapter[] = [YOUTUBE, JUTSU, KODIK, ALLOHA, PLAYERJS];

export function findAdapter(host: string, doc: Document): SiteAdapter | null {
  return ADAPTERS.find((a) => a.matches(host, doc)) ?? null;
}

/** Поиск <video> с проникновением в открытые shadow root (некоторые плееры прячут видео там). */
export function queryVideosDeep(root: ParentNode = document): HTMLVideoElement[] {
  const out: HTMLVideoElement[] = [];
  const walk = (node: ParentNode) => {
    out.push(...node.querySelectorAll<HTMLVideoElement>('video'));
    node.querySelectorAll<HTMLElement>('*').forEach((el) => {
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  };
  walk(root);
  return out;
}
