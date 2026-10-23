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
  MediaApplyFailedMsg,
  NoticeMsg,
} from '../shared/messages';
import { findAdapter, queryVideosDeep } from './adapters';
import { driftDecision, DriftNudger } from './drift';

/** Cold-start: отложенная команда, пока <video> ещё не готов (балансеры создают его
 *  лениво). readyState<1 или бесконечная duration → метаданных нет, применять некуда. */
export function shouldDeferApply(p: { hasVideo: boolean; readyState: number; durationFinite: boolean }): boolean {
  return !p.hasVideo || p.readyState < 1 || !p.durationFinite;
}

interface PendingApply { action: PlayerAction; currentTime: number; rate?: number; paused: boolean; pauseOnly?: boolean; }

const AD_POLL_MS = 500; // как часто проверяем состояние рекламы
const PRESENCE_REASSERT_MS = 4000; // ре-репорт «видео есть» — восстановление после выгрузки SW

const SEEK_EPSILON = 0.5;   // сек: порог, ниже которого не трогаем currentTime
const APPLY_RELEASE_MS = 400; // через сколько снимаем флаг isApplyingRemote
const HEARTBEAT_MS = 3000;  // период биения позиции (Фаза 2)
const BUFFER_WATCHDOG_MS = 1000; // как часто сторож проверяет выход из буферизации
const MAX_BUFFER_HOLD_MS = 30000; // жёсткий предел холда буфера — страховка от «зависшего» ожидания
const HARD_SEEK_S = 4;      // сек: выше этого дрейфа плавным нуджем не догнать — жёсткий seek
const NUDGE_FACTOR = 0.08;  // ±8% к базовой скорости — плавная подстройка при умеренном дрейфе

export class PlayerController {
  private video: HTMLVideoElement | null = null;
  private scanDirty = true;
  private desiredPaused: boolean | null = null;
  private timers: number[] = [];
  private scanTimer: number | null = null;
  private gestureRetry: (() => void) | null = null;
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
  private driftStrikes = 0;           // сколько BEAT подряд дрейф превысил порог (нужно ≥2 для коррекции)
  private nudger = new DriftNudger();  // плавная подстройка скоростью при умеренном дрейфе (пункт 1)

  start(): void {
    if (this.observer) return;
    this.scanDirty = true;
    this.scan();
    this.observer = new MutationObserver((records) => {
      if (records.every(r => (r.target as Element).closest?.('[data-syncwatch-ui]'))) return;
      const relevant = records.some(r => [...r.addedNodes, ...r.removedNodes].some(n =>
        n instanceof Element && (n.tagName === 'VIDEO' || n.shadowRoot || n.querySelector('video'))));
      if (!relevant && (!this.video || this.video.isConnected)) return;
      this.scanDirty = true;
      if (this.scanTimer != null) return;
      this.scanTimer = window.setTimeout(() => { this.scanTimer = null; this.scan(); }, 150);
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    // Плееры иногда подменяют <video> без мутаций в нашем поддереве — добиваем поллингом.
    this.timers.push(window.setInterval(() => this.scan(), 5000));
    this.timers.push(window.setInterval(() => { this.scanDirty = true; this.scan(); }, 15000));
    // Heartbeat позиции: гонит content-скрипт (alarms слишком грубые, мин. 30с).
    this.timers.push(window.setInterval(() => this.beat(), HEARTBEAT_MS));
    // Отслеживание рекламы (sync-aware): при своей рекламе держим партнёра на паузе.
    this.timers.push(window.setInterval(() => { if (this.video) this.checkAd(); }, AD_POLL_MS));
    // Ре-репорт присутствия: восстанавливает карту в background после выгрузки SW.
    this.timers.push(window.setInterval(() => { if (this.hasVideo) this.sendPresence(true); }, PRESENCE_REASSERT_MS));
    window.addEventListener('pagehide', this.stop, { once: true });
  }

  stop = (): void => {
    this.observer?.disconnect(); this.observer = null;
    for (const timer of this.timers) window.clearInterval(timer);
    this.timers = [];
    if (this.scanTimer != null) window.clearTimeout(this.scanTimer);
    if (this.applyTimer != null) window.clearTimeout(this.applyTimer);
    this.stopBufferWatchdog();
    this.detach();
    this.sendPresence(false);
    if (this.gestureRetry) {
      document.removeEventListener('pointerdown', this.gestureRetry, true);
      document.removeEventListener('keydown', this.gestureRetry, true);
    }
    window.removeEventListener('pagehide', this.stop);
  };

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
    if (adNow && this.isBuffering) this.setBuffering(false);
    this.isAdActive = adNow;
    if (adNow) this.cancelNudge(); // началась своя реклама — подстройку скоростью снимаем
    if (!adNow) {
      if (this.pendingApply) {
        const p = this.pendingApply; this.pendingApply = null;
        this.applyRemote(p.action, p.currentTime, p.paused, p.rate, p.pauseOnly);
      }
      this.applyHold();
      this.readySent = false; this.onReady();
    }
    const msg: AdMsg = { kind: 'ad', ad: adNow };
    browser.runtime.sendMessage(msg).catch(() => { /* SW перезапускается */ });
  }

  /** Найти и при необходимости переподключиться к активному <video>. */
  private scan(): void {
    const candidate = this.pickActiveVideo();
    this.scanDirty = false;
    if (candidate && candidate !== this.video) {
      this.attach(candidate);
    }
    if (!candidate && this.video) {
      if (this.isBuffering) this.setBuffering(false);
      this.detach();
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
   *  Он сам сменит источник → checkMediaSig затем отрепортит новое состояние (хаб подтвердит).
   *  Если применить не удалось (у нас нет такой озвучки/серии — наборы различаются) — сообщаем
   *  хабу наш РЕАЛЬНЫЙ выбор, чтобы он снял луп-гард и починил baseline (не откатывая комнату). */
  applyMediaSelection(sig: string): void {
    this.readySent = false;
    this.pendingApply = null;
    const adapter = findAdapter(location.hostname, document);
    if (!adapter?.applySelection) {
      browser.runtime.sendMessage({ kind: 'media-apply-failed', actualSig: null }).catch(() => {});
      return;
    }
    adapter.applySelection(sig, document, (ok) => {
      if (ok) { this.checkMediaSig(); this.onReady(); return; }
      const actualSig = adapter.getSelection?.(document)?.sig ?? null;
      const msg: MediaApplyFailedMsg = { kind: 'media-apply-failed', actualSig };
      browser.runtime.sendMessage(msg).catch(() => { /* SW перезапускается */ });
    });
  }

  private pickActiveVideo(): HTMLVideoElement | null {
    if (!this.scanDirty && (!this.video || this.video.isConnected)) return this.video;
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
    this.desiredPaused ??= video.paused;
    this.updatePresence(true);
    this.readySent = false; // новый элемент — video-ready отправим заново
    this.driftStrikes = 0;  // новый плеер — счётчик дрейфа с нуля
    video.addEventListener('play', this.onPlay);
    video.addEventListener('pause', this.onPause);
    video.addEventListener('seeked', this.onSeeked);
    video.addEventListener('ratechange', this.onRate);
    video.addEventListener('waiting', this.onWaiting);
    video.addEventListener('stalled', this.onWaiting);
    video.addEventListener('playing', this.onPlaying);
    // Cold-start (Фаза 1): дождаться метаданных, чтобы доиграть отложенную команду и
    // сообщить хабу о готовности. Если элемент уже готов — дёргаем onReady сразу.
    video.addEventListener('loadstart', this.onLoadStart);
    video.addEventListener('emptied', this.onLoadStart);
    video.addEventListener('loadedmetadata', this.onReady);
    video.addEventListener('canplay', this.onReady);
    video.addEventListener('durationchange', this.onReady);
    if (video.readyState >= 1 && Number.isFinite(video.duration)) this.onReady();
  }

  private detach(): void {
    if (!this.video) return;
    this.cancelNudge(); // уходит <video> — снимаем активную подстройку скоростью
    this.video.removeEventListener('play', this.onPlay);
    this.video.removeEventListener('pause', this.onPause);
    this.video.removeEventListener('seeked', this.onSeeked);
    this.video.removeEventListener('ratechange', this.onRate);
    this.video.removeEventListener('waiting', this.onWaiting);
    this.video.removeEventListener('stalled', this.onWaiting);
    this.video.removeEventListener('playing', this.onPlaying);
    this.video.removeEventListener('loadstart', this.onLoadStart);
    this.video.removeEventListener('emptied', this.onLoadStart);
    this.video.removeEventListener('loadedmetadata', this.onReady);
    this.video.removeEventListener('canplay', this.onReady);
    this.video.removeEventListener('durationchange', this.onReady);
    this.video = null;
  }

  /** <video> доиграл метаданные: раз на элемент шлём video-ready хабу и доигрываем
   *  отложенную команду (если была). Гейт по readyState/duration — против ложных срабатываний. */
  private onLoadStart = () => {
    this.readySent = false;
    this.driftStrikes = 0;
    this.cancelNudge();
    if (this.isBuffering) this.setBuffering(false);
  };

  private onReady = () => {
    const v = this.video;
    if (!v || this.isAdActive || v.readyState < 1 || !Number.isFinite(v.duration)) return;
    if (!this.readySent) {
      this.readySent = true;
      const msg: VideoReadyMsg = { kind: 'video-ready' };
      browser.runtime.sendMessage(msg).catch(() => { /* SW перезапускается */ });
    }
    if (this.pendingApply) {
      const p = this.pendingApply;
      this.pendingApply = null;
      this.applyRemote(p.action, p.currentTime, p.paused, p.rate, p.pauseOnly);
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
  private onPlay = () => {
    if (this.isApplyingRemote || this.isAdActive) return;
    this.desiredPaused = false;
    this.emit('play');
    if (this.heldByPeer()) this.applyHold();
  };
  private onPause = () => {
    this.cancelNudge();
    if (!this.isApplyingRemote && !this.isAdActive) { this.desiredPaused = true; this.emit('pause'); }
  };
  private onSeeked = () => { this.cancelNudge(); this.emit('seek'); };
  // ratechange от нашего же нуджа/возврата НЕ транслируем (эхо-детект по lastSetRate).
  // Если скорость поменял кто-то ещё (юзер/сеть) во время нуджа — бросаем нудж и транслируем.
  private onRate = () => {
    const v = this.video;
    if (this.nudger.isActive && v && Math.abs(v.playbackRate - this.nudger.lastSetRate) < 0.001) return;
    if (this.nudger.isActive) this.nudger.abandon(); // rate перехватил юзер/сеть — отдаём скорость
    this.emit('rate');
  };

  /** Снять активную подстройку скоростью с возвратом базовой (общая точка для гейтов). */
  private cancelNudge(): void { this.nudger.cancel(this.video, APPLY_RELEASE_MS); }

  /** Партнёр держит нас на паузе техническим холдом (буфер/реклама) — сквозь него не играем. */
  private heldByPeer(): boolean {
    return this.pausedByPeerBuffer || this.pausedByPeerAd || this.isAdActive;
  }

  /** Автопауза быстрого сообщения (Фаза 0.7.0): ставим паузу как ЛОКАЛЬНОЕ действие
   *  пользователя. Эхо-гейт (isApplyingRemote) намеренно НЕ ставим — штатный `pause`→
   *  onPause→emit→STATE уходит комнате (пауза разрешена всем), партнёры встают И видят причину. */
  pauseLocal(): void {
    const v = this.video;
    if (v && !v.paused) v.pause();
  }

  /** Текущий снимок для синка новичка при входе (запрос get-snapshot от хаба).
   *  `ready:false` (плеер ещё не доиграл метаданные) → хаб отбракует мусорный снимок. */
  snapshot(): PlayerSnapshot {
    const v = this.video;
    return {
      paused: this.desiredPaused ?? v?.paused ?? true,
      currentTime: v?.currentTime ?? 0,
      rate: this.nudger.isActive ? this.nudger.originalRate : v?.playbackRate ?? 1,
      ready: !!v && !this.isAdActive && v.readyState >= 1 && Number.isFinite(v.duration),
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
      this.cancelNudge(); // буфер-холд — плавную подстройку снимаем
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
    if (!v || v.ended || (v.paused && this.desiredPaused === true)) { this.setBuffering(false); return; } // паузу синкнет своё событие
    const advanced = v.currentTime > this.bufferStartTime + 0.1;
    if (v.readyState >= 3 && (advanced || v.paused && this.heldByPeer())) { this.setBuffering(false); return; } // реально проигрывается снова
    if (Date.now() - this.bufferStartedAt > MAX_BUFFER_HOLD_MS) {
      this.desiredPaused = true; this.setBuffering(false);
      this.isApplyingRemote = false; v.pause(); this.emit('pause');
      browser.runtime.sendMessage({ kind: 'notice', text: 'Видео долго не загружается — просмотр приостановлен. Нажмите ▶ после загрузки.' }).catch(() => {});
    } // страховка
  }

  private emitBuffering(buffering: boolean): void {
    if (!this.video || this.isAdActive) return; // буферизацию рекламы не транслируем
    const msg: BufferingMsg = { kind: 'buffering', buffering, currentTime: this.video.currentTime };
    browser.runtime.sendMessage(msg).catch(() => { /* SW перезапускается */ });
  }

  /** Применить удалённую команду (last-writer-wins), не порождая эхо (флаг isApplyingRemote).
   *  Технический холд буфера/рекламы партнёра имеет приоритет — сквозь него не играем. */
  applyRemote(action: PlayerAction, currentTime: number, paused: boolean, rate?: number, pauseOnly = false): void {
    if (!Number.isFinite(currentTime) || currentTime < 0 || (rate !== undefined && (!Number.isFinite(rate) || rate < 0.25 || rate > 4))) return;
    this.desiredPaused = paused;
    if (this.isAdActive) { this.pendingApply = { action, currentTime, paused, rate, pauseOnly }; return; }
    if (!this.video) this.scan();
    const v = this.video;
    // Cold-start (Фаза 1): плеер ещё не готов (нет <video>/метаданных) — не дропаем
    // команду, а откладываем; onReady доиграет её, когда балансер создаст и дозагрузит видео.
    if (shouldDeferApply({ hasVideo: !!v, readyState: v?.readyState ?? 0, durationFinite: v ? Number.isFinite(v.duration) : false })) {
      this.pendingApply = { action, currentTime, rate, paused, pauseOnly };
      return;
    }
    if (!v) return;

    this.isApplyingRemote = true;
    try {
      // Позицию выставляем для play/pause/seek (rate её не несёт).
      if (!pauseOnly && action !== 'rate' && Math.abs(v.currentTime - currentTime) > SEEK_EPSILON) {
        v.currentTime = currentTime;
      }
      this.nudger.abandon();
      if (!pauseOnly && rate !== undefined) v.playbackRate = rate;
      // Воспроизведение: последнее слово за отправителем, но не играем сквозь холд.
      if (!paused && !this.heldByPeer()) this.tryPlay(v);
      else v.pause();
    } finally {
      this.releaseSoon();
    }
  }

  /** Попытка воспроизведения с обработкой отказа автоплея (Фаза 1). Голый catch
   *  раньше глотал отказ → позиция вставала, но play молча не срабатывал. */
  private tryPlay(v: HTMLVideoElement): void {
    void v.play().catch((e: DOMException) => { if (e.name === 'NotAllowedError' && !this.desiredPaused) this.onAutoplayBlocked(); });
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
      this.gestureRetry = null;
      const v = this.video;
      if (v && v.paused && !this.desiredPaused && !this.heldByPeer()) void v.play().catch(() => { /* всё ещё нельзя */ });
    };
    this.gestureRetry = retry;
    document.addEventListener('pointerdown', retry, { once: true, capture: true });
    document.addEventListener('keydown', retry, { once: true, capture: true });
  }

  /** Партнёр буферизуется — встаём; возобновился — играем (если нет других холдов) (Фаза 2). */
  applyBufferControl(buffering: boolean): void {
    this.desiredPaused ??= this.video?.paused ?? true;
    this.pausedByPeerBuffer = buffering;
    this.applyHold();
  }

  /** Партнёр в рекламе — встаём; закончилась — играем (если нет других холдов) (Фаза 3). */
  applyAdControl(ad: boolean): void {
    this.desiredPaused ??= this.video?.paused ?? true;
    this.pausedByPeerAd = ad;
    this.applyHold();
  }

  /** Применить технический холд буфера/рекламы: пауза пока холд активен, иначе — возобновить. */
  private applyHold(): void {
    const v = this.video;
    if (!v || this.isAdActive) return;
    const held = this.heldByPeer() || (this.desiredPaused ?? v.paused);
    if (held === v.paused) return; // уже в нужном состоянии
    this.isApplyingRemote = true;
    try {
      if (held) v.pause();
      else this.tryPlay(v); // снятие холда: play с жест-фолбэком при блоке автоплея
    } finally {
      this.releaseSoon();
    }
  }

  private static readonly LOCAL_ACTION_COOLDOWN_MS = 1500;

  /** Не-опорный по дрейфу подтягивается к опорному при дрейфе сверх порога (Фаза 2).
   *  Двухступенчато: умеренный дрейф добираем плавно скоростью (нудж), большой — жёстким
   *  seek. Коррекция только после ДВУХ превышений подряд — одиночный выброс (лаг) не дёргает. */
  applyDriftCorrection(currentTime: number, _ts: number, threshold: number): void {
    const v = this.video;
    // Гейты коррекции: нет видео / буфер / реклама / пауза / конец / кулдаун после своей
    // команды (не откатываем свежую локальную позицию) — счётчик в ноль, нудж снимаем.
    const cooldown = Date.now() - this.lastLocalActionTs < PlayerController.LOCAL_ACTION_COOLDOWN_MS;
    if (!v || this.isBuffering || this.isAdActive || v.paused || v.ended || cooldown) {
      this.driftStrikes = 0;
      this.cancelNudge();
      return;
    }
    // ВАЖНО: НЕ компенсируем задержку через `ts` — он со стенных часов ДРУГОЙ машины, а
    // часы двух ПК не синхронны (рассинхрон в секунды — норма). Эта «компенсация» вносила
    // перекос часов прямо в позицию → откаты на 5–7с каждым биением. Реальная сетевая
    // задержка (доли секунды) и так покрыта порогом `threshold`.
    const diff = v.currentTime - currentTime; // знак: >0 мы впереди опорного, <0 отстаём
    if (Math.abs(diff) <= threshold) {
      this.driftStrikes = 0;
      this.cancelNudge(); // сошлись — возвращаем базовую скорость
      return;
    }
    this.driftStrikes++;
    const decision = driftDecision(diff, threshold, HARD_SEEK_S, this.driftStrikes);
    if (decision === 'none') return; // одиночный выброс — ждём подтверждения следующим битом
    if (decision === 'seek') {
      this.driftStrikes = 0;
      this.cancelNudge();
      this.isApplyingRemote = true;
      try {
        v.currentTime = currentTime;
      } finally {
        this.releaseSoon();
      }
      return;
    }
    this.nudger.start(v, diff, NUDGE_FACTOR); // 'nudge' — плавная подстройка скоростью
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
