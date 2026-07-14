// Универсальный детект и управление плеером внутри одного фрейма.
// Работает в каждом фрейме (all_frames); фрейм без <video> просто простаивает.

import browser from '../shared/browser';
import type { PlayerAction } from '../shared/protocol';
import type {
  PlayerEventMsg,
  BufferingMsg,
  BeatMsg,
  AdMsg,
  PlayerSnapshot,
  VideoPresenceMsg,
  VideoReadyMsg,
  MediaSigMsg,
  NoticeMsg,
} from '../shared/messages';
import { findAdapter, queryVideosDeep } from './adapters';

/** Cold-start: отложенная команда, пока <video> ещё не готов (балансеры создают его
 *  лениво). readyState<1 или бесконечная duration → метаданных нет, применять некуда. */
export function shouldDeferApply(p: { hasVideo: boolean; readyState: number; durationFinite: boolean }): boolean {
  return !p.hasVideo || p.readyState < 1 || !p.durationFinite;
}

interface PendingApply { action: PlayerAction; currentTime: number; rate?: number; paused: boolean; }

const AD_POLL_MS = 500; // как часто проверяем состояние рекламы
const PRESENCE_REASSERT_MS = 4000; // ре-репорт «видео есть» — восстановление после выгрузки SW

const SEEK_EPSILON = 0.5;   // сек: порог, ниже которого не трогаем currentTime
const APPLY_RELEASE_MS = 400; // через сколько снимаем флаг isApplyingRemote
const HEARTBEAT_MS = 3000;  // период биения позиции (Фаза 2)
const BUFFER_WATCHDOG_MS = 1000; // как часто сторож проверяет выход из буферизации
const MAX_BUFFER_HOLD_MS = 30000; // жёсткий предел холда буфера — страховка от «зависшего» ожидания

export class PlayerController {
  private video: HTMLVideoElement | null = null;
  private isApplyingRemote = false;
  private applyTimer: number | null = null;
  private observer: MutationObserver | null = null;
  private isBuffering = false;        // мы сейчас буферизуемся (Фаза 2)
  private bufferWatchdog: number | null = null; // сторож выхода из буферизации (см. checkBufferRecovered)
  private bufferStartedAt = 0;        // Date.now() старта буферизации — для жёсткого предела холда
  private bufferStartTime = 0;        // v.currentTime на старте — «позиция сдвинулась» = возобновились
  private pausedByPeerBuffer = false; // нас поставил на паузу буфер партнёра (Фаза 2)
  private isAdActive = false;         // у нас сейчас идёт реклама (Фаза 3)
  private pausedByPeerAd = false;     // нас поставила на паузу реклама партнёра (Фаза 3)
  private lastLocalActionTs = 0;      // когда мы сами play/pause/seek — защита от отката дрейфом
  private hasVideo = false;           // есть ли в этом фрейме <video> (для гейтинга островка)
  private presenceReported = false;   // отправляли ли хотя бы раз статус присутствия
  private pendingApply: PendingApply | null = null; // отложенная команда до готовности <video> (Фаза 1)
  private awaitingGesture = false;    // автоплей заблокирован — ждём клик/клавишу, чтобы доиграть play (Фаза 1)
  private readySent = false;          // отправляли ли video-ready для ТЕКУЩЕГО элемента (раз на элемент)
  private lastSigReported: string | null = null; // последняя отправленная подпись серии/озвучки (Фаза 3)

  start(): void {
    this.scan();
    this.observer = new MutationObserver(() => this.scan());
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    // Плееры иногда подменяют <video> без мутаций в нашем поддереве — добиваем поллингом.
    window.setInterval(() => this.scan(), 2000);
    // Heartbeat позиции: гонит content-скрипт (alarms слишком грубые, мин. 30с).
    window.setInterval(() => this.beat(), HEARTBEAT_MS);
    // Отслеживание рекламы (sync-aware): при своей рекламе держим партнёра на паузе.
    window.setInterval(() => this.checkAd(), AD_POLL_MS);
    // Ре-репорт присутствия: восстанавливает карту в background после выгрузки SW.
    window.setInterval(() => { if (this.hasVideo) this.sendPresence(true); }, PRESENCE_REASSERT_MS);
  }

  /** Сообщить background, есть ли в этом фрейме видео. Пуш при смене состояния или
   *  впервые; ре-репорт `true` идёт периодически (идемпотентно для агрегатора). */
  private updatePresence(present: boolean): void {
    if (this.presenceReported && present === this.hasVideo) return;
    this.hasVideo = present;
    this.presenceReported = true;
    this.sendPresence(present);
  }

  private sendPresence(present: boolean): void {
    const msg: VideoPresenceMsg = { kind: 'video-presence', present };
    browser.runtime.sendMessage(msg).catch(() => { /* SW перезапускается */ });
  }

  /** Периодическое биение позиции в background (только при воспроизведении, не во время рекламы). */
  private beat(): void {
    const v = this.video;
    if (!v || v.paused || v.ended || this.isAdActive) return;
    const msg: BeatMsg = { kind: 'beat', currentTime: v.currentTime, playing: true };
    browser.runtime.sendMessage(msg).catch(() => { /* SW перезапускается */ });
  }

  /** Детект начала/конца рекламы через сайт-адаптер → уведомление партнёра. */
  private checkAd(): void {
    const adapter = findAdapter(location.hostname, document);
    const adNow = adapter?.isAd?.(document) ?? false;
    if (adNow === this.isAdActive) return;
    this.isAdActive = adNow;
    const msg: AdMsg = { kind: 'ad', ad: adNow };
    browser.runtime.sendMessage(msg).catch(() => { /* SW перезапускается */ });
  }

  /** Найти и при необходимости переподключиться к активному <video>. */
  private scan(): void {
    const candidate = this.pickActiveVideo();
    if (candidate && candidate !== this.video) {
      this.attach(candidate);
    }
    // Присутствие видео для гейтинга островка. Подмена <video> всегда даёт непустого
    // кандидата → не мигаем; `false` уходит только когда видео реально нет во фрейме.
    this.updatePresence(candidate != null);
    // Синхрон серии/озвучки (Фаза 3): репорт подписи выбора при смене (только сайты с адаптером).
    this.checkMediaSig();
  }

  /** Если у фрейма есть адаптер с выбором серии/сезона/озвучки — сообщаем хабу подпись
   *  при её смене. Дженерик-фолбэка нет: только явные адаптеры (Kodik), иначе синхронить нечего. */
  private checkMediaSig(): void {
    const adapter = findAdapter(location.hostname, document);
    const sel = adapter?.getSelection?.(document) ?? null;
    if (!sel || sel.sig === this.lastSigReported) return;
    this.lastSigReported = sel.sig;
    const msg: MediaSigMsg = { kind: 'media-sig', sig: sel.sig, human: sel.human };
    browser.runtime.sendMessage(msg).catch(() => { /* SW перезапускается */ });
  }

  /** Применить выбор серии/озвучки партнёра: драйвим родной UI плеера через адаптер.
   *  Он сам сменит источник → checkMediaSig затем отрепортит новое состояние (хаб подтвердит). */
  applyMediaSelection(sig: string): void {
    const adapter = findAdapter(location.hostname, document);
    adapter?.applySelection?.(sig, document);
  }

  private pickActiveVideo(): HTMLVideoElement | null {
    // 0) Сайт-специфичный оверрайд, если для хоста/DOM есть адаптер.
    const adapter = findAdapter(location.hostname, document);
    if (adapter) {
      const v = adapter.pick(document);
      if (v) return v;
      // адаптер не нашёл — мягко откатываемся к универсальной эвристике ниже
    }

    // Универсальный фолбэк (с проникновением в открытые shadow root).
    const videos = queryVideosDeep();
    if (videos.length === 0) return null;

    // 1) реально играющее видео — лучший признак активного плеера
    const playing = videos.find((v) => !v.paused && !v.ended && v.readyState > 2);
    if (playing) return playing;

    // 2) иначе — самое большое по площади из тех, у кого есть длительность
    const withDuration = videos
      .filter((v) => Number.isFinite(v.duration) && v.duration > 0)
      .sort((a, b) => area(b) - area(a));
    return withDuration[0] ?? videos[0];
  }

  private attach(video: HTMLVideoElement): void {
    // Плеер мог подменить <video> прямо во время буферизации (частый случай — смена
    // качества): старый элемент уже не пришлёт `playing`, поэтому снимаем зависший холд,
    // иначе партнёр остаётся на нашей паузе до переподключения.
    if (this.isBuffering) this.setBuffering(false);
    this.detach();
    this.video = video;
    this.readySent = false; // новый элемент — video-ready отправим заново
    video.addEventListener('play', this.onPlay);
    video.addEventListener('pause', this.onPause);
    video.addEventListener('seeked', this.onSeeked);
    video.addEventListener('ratechange', this.onRate);
    video.addEventListener('waiting', this.onWaiting);
    video.addEventListener('stalled', this.onWaiting);
    video.addEventListener('playing', this.onPlaying);
    // Cold-start (Фаза 1): дождаться метаданных, чтобы доиграть отложенную команду и
    // сообщить хабу о готовности. Если элемент уже готов — дёргаем onReady сразу.
    video.addEventListener('loadedmetadata', this.onReady);
    video.addEventListener('canplay', this.onReady);
    video.addEventListener('durationchange', this.onReady);
    if (video.readyState >= 1 && Number.isFinite(video.duration)) this.onReady();
  }

  private detach(): void {
    if (!this.video) return;
    this.video.removeEventListener('play', this.onPlay);
    this.video.removeEventListener('pause', this.onPause);
    this.video.removeEventListener('seeked', this.onSeeked);
    this.video.removeEventListener('ratechange', this.onRate);
    this.video.removeEventListener('waiting', this.onWaiting);
    this.video.removeEventListener('stalled', this.onWaiting);
    this.video.removeEventListener('playing', this.onPlaying);
    this.video.removeEventListener('loadedmetadata', this.onReady);
    this.video.removeEventListener('canplay', this.onReady);
    this.video.removeEventListener('durationchange', this.onReady);
    this.video = null;
  }

  /** <video> доиграл метаданные: раз на элемент шлём video-ready хабу и доигрываем
   *  отложенную команду (если была). Гейт по readyState/duration — против ложных срабатываний. */
  private onReady = () => {
    const v = this.video;
    if (!v || v.readyState < 1 || !Number.isFinite(v.duration)) return;
    if (!this.readySent) {
      this.readySent = true;
      const msg: VideoReadyMsg = { kind: 'video-ready' };
      browser.runtime.sendMessage(msg).catch(() => { /* SW перезапускается */ });
    }
    if (this.pendingApply) {
      const p = this.pendingApply;
      this.pendingApply = null;
      this.applyRemote(p.action, p.currentTime, p.paused, p.rate);
    }
  };

  /** Транслировать локальное действие в background (если оно не вызвано сетью или рекламой). */
  private emit(action: PlayerAction): void {
    if (this.isApplyingRemote || this.isAdActive || !this.video) return;
    this.lastLocalActionTs = Date.now(); // защищаем свежую локальную команду от отката дрейфом
    const msg: PlayerEventMsg = {
      kind: 'player-event',
      action,
      currentTime: this.video.currentTime,
      rate: this.video.playbackRate,
      paused: this.video.paused, // реальное состояние (для баннера статуса у партнёра)
    };
    browser.runtime.sendMessage(msg).catch(() => { /* SW перезапускается */ });
  }

  // last-writer-wins: локальные play/pause просто транслируем, удалённые — применяем.
  // Гейт isApplyingRemote гасит эхо (наши же программные play/pause/seek не транслируем).
  private onPlay = () => { if (!this.isApplyingRemote) this.emit('play'); };
  private onPause = () => { if (!this.isApplyingRemote) this.emit('pause'); };
  private onSeeked = () => this.emit('seek');
  private onRate = () => this.emit('rate');

  /** Партнёр держит нас на паузе техническим холдом (буфер/реклама) — сквозь него не играем. */
  private heldByPeer(): boolean {
    return this.pausedByPeerBuffer || this.pausedByPeerAd || this.isAdActive;
  }

  /** Текущий снимок для синка новичка при входе (запрос get-snapshot от хаба).
   *  `ready:false` (плеер ещё не доиграл метаданные) → хаб отбракует мусорный снимок. */
  snapshot(): PlayerSnapshot {
    const v = this.video;
    return {
      paused: v?.paused ?? true,
      currentTime: v?.currentTime ?? 0,
      rate: v?.playbackRate ?? 1,
      ready: !!v && v.readyState >= 1 && Number.isFinite(v.duration),
    };
  }

  // Буферизация: сообщаем партнёру, чтобы он подождал. Гейт isApplyingRemote
  // отсекает ложные срабатывания от наших же программных seek.
  private onWaiting = () => {
    if (this.isApplyingRemote || this.isBuffering || !this.video || this.video.paused) return;
    this.setBuffering(true);
  };

  private onPlaying = () => {
    if (this.isBuffering) this.setBuffering(false);
  };

  /** Единая точка входа/выхода из буферизации: эмит партнёру + сторож-таймер.
   *  Сторож обязателен, потому что событие `playing` после смены качества/подмены <video>
   *  может НЕ прийти — тогда без него партнёр «завис» бы на нашей паузе до переподключения. */
  private setBuffering(on: boolean): void {
    if (on === this.isBuffering) return;
    this.isBuffering = on;
    if (on) {
      this.bufferStartedAt = Date.now();
      this.bufferStartTime = this.video?.currentTime ?? 0;
      this.startBufferWatchdog();
    } else {
      this.stopBufferWatchdog();
    }
    this.emitBuffering(on);
  }

  private startBufferWatchdog(): void {
    if (this.bufferWatchdog != null) return;
    this.bufferWatchdog = window.setInterval(() => this.checkBufferRecovered(), BUFFER_WATCHDOG_MS);
  }

  private stopBufferWatchdog(): void {
    if (this.bufferWatchdog != null) { window.clearInterval(this.bufferWatchdog); this.bufferWatchdog = null; }
  }

  /** Резервный выход из буферизации, когда `playing` не пришёл (смена качества и т.п.):
   *  видео исчезло/встало/кончилось — либо реально пошло дальше — либо истёк жёсткий предел. */
  private checkBufferRecovered(): void {
    if (!this.isBuffering) { this.stopBufferWatchdog(); return; }
    const v = this.video;
    if (!v || v.paused || v.ended) { this.setBuffering(false); return; } // паузу синкнет своё событие
    const advanced = v.currentTime > this.bufferStartTime + 0.1;
    if (v.readyState >= 3 && advanced) { this.setBuffering(false); return; } // реально проигрывается снова
    if (Date.now() - this.bufferStartedAt > MAX_BUFFER_HOLD_MS) this.setBuffering(false); // страховка
  }

  private emitBuffering(buffering: boolean): void {
    if (!this.video || this.isAdActive) return; // буферизацию рекламы не транслируем
    const msg: BufferingMsg = { kind: 'buffering', buffering, currentTime: this.video.currentTime };
    browser.runtime.sendMessage(msg).catch(() => { /* SW перезапускается */ });
  }

  /** Применить удалённую команду (last-writer-wins), не порождая эхо (флаг isApplyingRemote).
   *  Технический холд буфера/рекламы партнёра имеет приоритет — сквозь него не играем. */
  applyRemote(action: PlayerAction, currentTime: number, paused: boolean, rate?: number): void {
    if (!this.video) this.scan();
    const v = this.video;
    // Cold-start (Фаза 1): плеер ещё не готов (нет <video>/метаданных) — не дропаем
    // команду, а откладываем; onReady доиграет её, когда балансер создаст и дозагрузит видео.
    if (shouldDeferApply({ hasVideo: !!v, readyState: v?.readyState ?? 0, durationFinite: v ? Number.isFinite(v.duration) : false })) {
      this.pendingApply = { action, currentTime, rate, paused };
      return;
    }
    if (!v) return;

    this.isApplyingRemote = true;
    try {
      // Позицию выставляем для play/pause/seek (rate её не несёт).
      if (action !== 'rate' && Math.abs(v.currentTime - currentTime) > SEEK_EPSILON) {
        v.currentTime = currentTime;
      }
      if (action === 'rate' && rate) v.playbackRate = rate;
      // Воспроизведение: последнее слово за отправителем, но не играем сквозь холд.
      if (action === 'play' && !this.heldByPeer()) this.tryPlay(v);
      else if (action === 'pause') v.pause();
    } finally {
      this.releaseSoon();
    }
  }

  /** Попытка воспроизведения с обработкой отказа автоплея (Фаза 1). Голый catch
   *  раньше глотал отказ → позиция вставала, но play молча не срабатывал. */
  private tryPlay(v: HTMLVideoElement): void {
    void v.play().catch(() => this.onAutoplayBlocked());
  }

  /** Автоплей заблокирован политикой браузера: тост + разовые слушатели жеста
   *  (клик/клавиша) на документе → повторить play, когда пользователь взаимодействует. */
  private onAutoplayBlocked(): void {
    if (this.awaitingGesture) return;
    this.awaitingGesture = true;
    const msg: NoticeMsg = {
      kind: 'notice',
      text: 'Автовоспроизведение заблокировано — кликните по странице или нажмите ▶',
    };
    browser.runtime.sendMessage(msg).catch(() => { /* SW перезапускается */ });
    const retry = () => {
      document.removeEventListener('pointerdown', retry, true);
      document.removeEventListener('keydown', retry, true);
      this.awaitingGesture = false;
      const v = this.video;
      if (v && v.paused && !this.heldByPeer()) void v.play().catch(() => { /* всё ещё нельзя */ });
    };
    document.addEventListener('pointerdown', retry, { once: true, capture: true });
    document.addEventListener('keydown', retry, { once: true, capture: true });
  }

  /** Партнёр буферизуется — встаём; возобновился — играем (если нет других холдов) (Фаза 2). */
  applyBufferControl(buffering: boolean): void {
    if (!this.video || this.isAdActive) return; // во время своей рекламы паузу не трогаем
    this.pausedByPeerBuffer = buffering;
    this.applyHold();
  }

  /** Партнёр в рекламе — встаём; закончилась — играем (если нет других холдов) (Фаза 3). */
  applyAdControl(ad: boolean): void {
    if (!this.video || this.isAdActive) return; // своя реклама — наш <video> её и показывает
    this.pausedByPeerAd = ad;
    this.applyHold();
  }

  /** Применить технический холд буфера/рекламы: пауза пока холд активен, иначе — возобновить. */
  private applyHold(): void {
    const v = this.video;
    if (!v) return;
    const held = this.heldByPeer();
    if (held === !v.paused) return; // уже в нужном состоянии
    this.isApplyingRemote = true;
    try {
      if (held) v.pause();
      else this.tryPlay(v); // снятие холда: play с жест-фолбэком при блоке автоплея
    } finally {
      this.releaseSoon();
    }
  }

  private static readonly LOCAL_ACTION_COOLDOWN_MS = 1500;

  /** Не-опорный по дрейфу подтягивается к опорному при дрейфе сверх порога (Фаза 2). */
  applyDriftCorrection(currentTime: number, _ts: number, threshold: number): void {
    const v = this.video;
    if (!v || this.isBuffering || this.isAdActive || v.paused || v.ended) return;
    // Кулдаун: после своей команды не даём биению опорного откатить нашу свежую позицию,
    // пока команда долетает и применяется у партнёра.
    if (Date.now() - this.lastLocalActionTs < PlayerController.LOCAL_ACTION_COOLDOWN_MS) return;
    // ВАЖНО: НЕ компенсируем задержку через `ts` — он со стенных часов ДРУГОЙ машины, а
    // часы двух ПК не синхронны (рассинхрон в секунды — норма). Эта «компенсация» вносила
    // перекос часов прямо в позицию → откаты на 5–7с каждым биением. Реальная сетевая
    // задержка (доли секунды) и так покрыта порогом `threshold`.
    const target = currentTime;
    if (Math.abs(v.currentTime - target) <= threshold) return;
    this.isApplyingRemote = true;
    try {
      v.currentTime = target;
    } finally {
      this.releaseSoon();
    }
  }

  /** Снять флаг isApplyingRemote после того, как отработают вызванные нами события. */
  private releaseSoon(): void {
    if (this.applyTimer) window.clearTimeout(this.applyTimer);
    this.applyTimer = window.setTimeout(() => { this.isApplyingRemote = false; }, APPLY_RELEASE_MS);
  }
}

function area(v: HTMLVideoElement): number {
  const r = v.getBoundingClientRect();
  return r.width * r.height;
}
