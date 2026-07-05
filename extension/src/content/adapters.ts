// Сайт-специфичные оверрайды детекта плеера (Фаза 3).
// Универсальная эвристика в player.ts покрывает большинство сайтов; адаптеры нужны там,
// где несколько <video> сбивают выбор, плеер в shadow DOM или его надо взять по селектору.
// Адаптер возвращает null → откат к универсальной эвристике (мягкая деградация).

export interface SiteAdapter {
  name: string;
  /** Матч по хосту И/ИЛИ по сигнатуре DOM (для iframe пиратских балансеров домен неизвестен). */
  matches(host: string, doc: Document): boolean;
  /** Вернуть канонический <video> сайта или null для отката к универсальному поиску. */
  pick(doc: Document): HTMLVideoElement | null;
  /** Идёт ли сейчас реклама (для sync-aware поведения). Не задан → реклама не детектится. */
  isAd?(doc: Document): boolean;
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

const ADAPTERS: SiteAdapter[] = [YOUTUBE, JUTSU, PLAYERJS];

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
