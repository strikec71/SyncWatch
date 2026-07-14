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
   *  чтобы он сам сменил источник. Не задан → синхрон выбора для сайта не поддержан. */
  applySelection?(sig: string, doc: Document): void;
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
  applySelection: (sig, doc) => {
    const want = kodikParseSig(sig);
    if (!want) return;
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
      if (!done && --left > 0) setTimeout(step, KODIK_APPLY_INTERVAL_MS);
    };
    step();
  },
};

const ADAPTERS: SiteAdapter[] = [YOUTUBE, JUTSU, KODIK, PLAYERJS];

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
