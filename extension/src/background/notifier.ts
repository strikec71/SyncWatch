// Нотификатор обновлений (Фаза B). Периодически спрашивает ${server}/version и, если
// удалённая версия ВЫШЕ установленной, пушит `update-available` в оверлей.
// MV3: авто-скачивания НЕТ (пользователь обновляет вручную). Любая ошибка/невалидный
// JSON — тихо выходим (RB4), никогда не бросаем из обработчика alarm'а. Только browser.*.

import browser from '../shared/browser';
import { loadSettings } from '../shared/settings';
import { pushUpdateAvailable } from './roster';

/** a > b по semver (сегменты major.minor.patch). Нечисловой/отсутствующий сегмент → 0. */
export function semverGt(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

function parseSemver(v: string): [number, number, number] {
  const p = String(v).split('.').map((s) => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

/** ws(s)://host → http(s)://host (без хвостовых слэшей). Для GET /version.
 *  Схему матчим без учёта регистра, но нормализуем к нижнему явно (не через `$1` —
 *  тот вернул бы захват в исходном регистре: 'WSS://' → 'httpS://'). */
export function httpBaseFromWs(serverUrl: string): string {
  return serverUrl
    .replace(/^wss:\/\//i, 'https://')
    .replace(/^ws:\/\//i, 'http://') // 'https://' уже не начинается с 'ws' — повторно не сматчит
    .replace(/\/+$/, '');
}

/** Проверить наличие новой сборки. Валидирует JSON на границе и молча падает при ошибке. */
export async function checkForUpdate(): Promise<void> {
  try {
    const s = await loadSettings();
    if (!s.serverUrl) return;
    const res = await fetch(`${httpBaseFromWs(s.serverUrl)}/version`);
    if (!res.ok) return;
    const json: unknown = await res.json();
    if (typeof json !== 'object' || json === null) return;
    const version = (json as Record<string, unknown>).version;
    if (typeof version !== 'string') return; // граница: только строка идёт дальше
    const local = browser.runtime.getManifest().version;
    if (semverGt(version, local)) pushUpdateAvailable(version);
  } catch { /* сеть/парсинг упал — тихо (RB4) */ }
}
