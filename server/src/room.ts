// Durable Object «Room»: держит до 10 сокетов одной комнаты и релеит между ними.
// Вся логика решений — в roomLogic.ts (чисто, тестируемо). Здесь только обвязка сокетов:
// назначение connId, roster-карта, рассылка ROSTER, инъекция `from`, снапшот-реквесты.
// Сервер — defense-in-depth: тот же permission-гейт дублируется на клиенте.

import { parseWire } from '../../extension/src/shared/protocol';
import type {
  ControlMessage,
  JoinMessage,
  ModeMessage,
  WireMessage,
} from '../../extension/src/shared/protocol';
import { decide, electHost, shapeRoster, staleConnIds } from './roomLogic';
import type { PeerState } from './roomLogic';

const MAX_PEERS = 10;

// Реапинг «мёртвых» сокетов: участник, молчащий дольше — считается отвалившимся, даже если
// событие close не пришло (полу-открытый TCP / выгрузка MV3 SW). Порог с запасом БОЛЬШЕ
// клиентского keepalive-PING (Chrome ~30с, Firefox ~60с), чтобы НЕ выгнать живого-но-паузного
// участника: 2 мин = терпим 1–3 пропущенных пинга. Активный зритель шлёт BEAT/STATE чаще.
const STALE_PEER_MS = 120000;

interface Entry {
  ws: WebSocket;
  state: PeerState;
  /** Date.now() последнего входящего от этого сокета (любое сообщение, вкл. PING). */
  lastSeenAt: number;
}

export class Room {
  private peers = new Map<number, Entry>();
  private nextConnId = 1; // монотонный per-room; никогда не переиспользуется
  private pendingReap = new Set<WebSocket>(); // сокеты, чей send бросил — вычистить после рассылки

  // state нужен сигнатуре конструктора DO, но хранилище мы не используем (чистый релей).
  constructor(_state: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.accept(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private accept(ws: WebSocket): void {
    ws.accept();

    if (this.peers.size >= MAX_PEERS) {
      ws.close(1013, 'room full');
      return;
    }

    const connId = this.nextConnId++;
    const entry: Entry = {
      ws,
      state: { connId, name: '', isHost: false, hasControl: false, detached: false },
      lastSeenAt: Date.now(),
    };
    this.peers.set(connId, entry);

    ws.addEventListener('message', (evt: MessageEvent) => {
      if (typeof evt.data === 'string') this.handleMessage(entry, evt.data);
    });
    const done = () => this.cleanup(entry);
    ws.addEventListener('close', done);
    ws.addEventListener('error', done);
  }

  private handleMessage(entry: Entry, raw: string): void {
    const msg = parseWire(raw); // валидация на границе; мусор → игнор
    if (!msg) return;
    entry.lastSeenAt = Date.now(); // живость: обновляем ДО обработки (PING тоже считается)

    this.dispatch(entry, msg);

    // После рассылки — вычищаем мёртвые сокеты: те, чей send бросил (pendingReap), и молчащие
    // дольше порога (сюда попадает «призрак», чей close не пришёл). Раз на сообщение — дёшево (≤10).
    this.reapDead();
  }

  private dispatch(entry: Entry, msg: WireMessage): void {
    switch (msg.type) {
      case 'JOIN':
        this.onJoin(entry, msg);
        return;
      case 'MODE':
        this.onMode(entry, msg);
        return;
      case 'CONTROL':
        this.onControl(entry, msg);
        return;
      default:
        this.relay(entry, msg);
        return;
    }
  }

  /** Реапинг мёртвых участников: сначала те, чей send бросил (pendingReap), затем молчащие
   *  дольше STALE_PEER_MS (staleConnIds). Удаляем без ожидания (не)приходящего close-события,
   *  затем один раз переизбираем host и рассылаем актуальный roster. */
  private reapDead(): void {
    const dead: number[] = [];
    for (const [id, e] of this.peers) if (this.pendingReap.has(e.ws)) dead.push(id);
    this.pendingReap.clear();

    const now = Date.now();
    const stale = staleConnIds(
      [...this.peers.values()].map((e) => ({ connId: e.state.connId, lastSeenAt: e.lastSeenAt })),
      now,
      STALE_PEER_MS,
    );
    for (const id of stale) if (!dead.includes(id)) dead.push(id);
    if (dead.length === 0) return;

    for (const id of dead) {
      const e = this.peers.get(id);
      if (!e) continue;
      try { e.ws.close(1001, 'stale'); } catch { /* уже мёртв */ }
      this.peers.delete(id); // вручную: close-событие могло не прийти (полу-открытый сокет)
    }
    if (this.peers.size > 0) { this.reelectHost(); this.broadcastRoster(); }
  }

  /** JOIN: закрепляем имя, переизбираем host, рассылаем ROSTER, просим у host снапшот новичку. */
  private onJoin(entry: Entry, msg: JoinMessage): void {
    entry.state.name = msg.name;
    const host = this.reelectHost();
    this.broadcastRoster();
    this.requestSnapshotIfPeer(entry, host);
  }

  /** MODE: переключаем detach, переизбираем host (detached-host заменяется), при un-detach просим снапшот. */
  private onMode(entry: Entry, msg: ModeMessage): void {
    entry.state.detached = msg.detached;
    const host = this.reelectHost();
    this.broadcastRoster();
    if (!msg.detached) this.requestSnapshotIfPeer(entry, host);
  }

  /** CONTROL: только host выдаёт/забирает право управления. */
  private onControl(entry: Entry, msg: ControlMessage): void {
    if (!entry.state.isHost) return;
    const target = this.peers.get(msg.target);
    if (!target) return;
    target.state.hasControl = msg.action === 'grant';
    this.broadcastRoster();
  }

  /** Релей STATE/BUFFER/AD/BEAT/PING по решению decide(). */
  private relay(entry: Entry, msg: WireMessage): void {
    const d = decide(msg, entry.state, this.peers.size);
    switch (d.kind) {
      case 'consume':
        // PING keepalive: эхо-понг ТОЛЬКО отправителю (не фанаут). Обновляет его
        // lastRecvAt, чтобы watchdog не рвал здоровое-но-тихое соединение. Дрейф не
        // трогает — это PING, а не BEAT (см. фикс ложного реконнекта, чекпоинт A).
        if (msg.type === 'PING') this.trySend(entry.ws, this.serialize(msg, null));
        return;
      case 'drop':
        return;
      case 'toHost': {
        // REQUEST_CONTROL → только текущему host, from = проситель. Host — по флагу isHost
        // (держится корректным reelectHost при каждом join/leave/mode; НЕ переизбираем тут, RB1).
        const host = [...this.peers.values()].find((e) => e.state.isHost);
        if (!host || host.state.connId === entry.state.connId) return; // нет host / сам host — молча роняем
        this.trySend(host.ws, this.serialize(msg, d.target));
        return;
      }
      case 'broadcast': {
        const data = this.serialize(msg, d.inject ? entry.state.connId : null);
        for (const [id, e] of this.peers) {
          if (id !== entry.state.connId) this.trySend(e.ws, data);
        }
        return;
      }
      case 'directed': {
        const target = this.peers.get(d.target);
        if (!target) return; // R2: адресат ушёл — молча роняем, НИКОГДА не бродкастим снапшот
        this.trySend(target.ws, this.serialize(msg, d.inject ? entry.state.connId : null));
        return;
      }
    }
  }

  /** SNAPSHOT_REQ хосту, если новичок/re-sync не сам host. */
  private requestSnapshotIfPeer(entry: Entry, host: number | null): void {
    if (host === null || host === entry.state.connId) return;
    const h = this.peers.get(host);
    if (h) this.trySend(h.ws, JSON.stringify({ type: 'SNAPSHOT_REQ', target: entry.state.connId }));
  }

  /** Переизбрать host по roomLogic.electHost и проставить флаги isHost. */
  private reelectHost(): number | null {
    const states = this.states();
    const host = electHost(states);
    for (const e of this.peers.values()) {
      e.state.isHost = host !== null && e.state.connId === host;
    }
    return host;
  }

  /** Разослать каждому персональный ROSTER (свой self). */
  private broadcastRoster(): void {
    const states = this.states();
    for (const e of this.peers.values()) {
      this.trySend(e.ws, JSON.stringify(shapeRoster(states, e.state.connId)));
    }
  }

  /** Уход участника: удаляем, переизбираем host, рассылаем ROSTER остатку. */
  private cleanup(entry: Entry): void {
    if (!this.peers.delete(entry.state.connId)) return;
    if (this.peers.size === 0) return; // пусто — DO простаивает, чистить нечего
    this.reelectHost();
    this.broadcastRoster();
  }

  private states(): PeerState[] {
    return [...this.peers.values()].map((e) => e.state);
  }

  /** Сериализация с инъекцией from (перезапись любого клиентского from → санитайз). */
  private serialize(msg: WireMessage, from: number | null): string {
    if (from === null) return JSON.stringify(msg);
    return JSON.stringify({ ...(msg as unknown as Record<string, unknown>), from });
  }

  private trySend(ws: WebSocket, data: string): void {
    try {
      ws.send(data);
    } catch {
      // Сокет мёртв — НЕ ждём (не)приходящего close: помечаем на реапинг. Не удаляем прямо
      // здесь, т.к. trySend зовётся ВНУТРИ цикла рассылки (мутация peers на ходу). reapDead()
      // в конце handleMessage вычистит помеченные и разошлёт свежий roster.
      this.pendingReap.add(ws);
    }
  }
}
