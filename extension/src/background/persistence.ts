import browser from '../shared/browser';
import { allSessions, getSession } from './state';
import { normalizeServerUrl } from '../shared/validation';
import { validRoom } from '../shared/protocol';

let queue: Promise<unknown> = Promise.resolve();
export function persistSessions(): Promise<void> {
  const records = allSessions().filter(s => s.room && !s.intentionalClose).map(s => ({
    tabId: s.tabId, frameId: s.frameId, room: s.room, serverUrl: s.serverUrl, detached: s.detached,
    navigationOrigin: s.navigationOrigin, autoConnect: s.autoConnect, idleClosed: s.idleClosed, pageUrl: s.pageUrl, mediaSig: s.mediaSig,
  }));
  const write = queue.catch(() => {}).then(async () => { await browser.storage.session.set({ sessions: records }); });
  queue = write;
  return write;
}
export async function restoreSessions(): Promise<void> {
  const data = await browser.storage.session.get('sessions');
  if (!Array.isArray(data.sessions)) return;
  for (const record of data.sessions) {
    if (!Number.isInteger(record.tabId) || !validRoom(record.room) || !normalizeServerUrl(record.serverUrl)) continue;
    // Incoming content messages may have established a new session during restore.
    const existing = allSessions().find(s => s.tabId === record.tabId);
    if (existing?.room) continue;
    try {
      const tab = await browser.tabs.get(record.tabId);
      if (!tab.url || !/^https?:/.test(tab.url)) continue;
      const s = getSession(record.tabId);
      if (s.room) continue;
      s.navigationOrigin = typeof record.navigationOrigin === 'string' ? record.navigationOrigin : '';
      s.frameId = Number.isInteger(record.frameId) && record.frameId >= 0 ? record.frameId : 0;
      s.room = record.room; s.serverUrl = record.serverUrl;
      s.detached = record.detached === true; s.autoConnect = record.autoConnect !== false;
      s.idleClosed = record.idleClosed === true;
      s.pageUrl = typeof record.pageUrl === 'string' ? record.pageUrl : '';
      s.mediaSig = typeof record.mediaSig === 'string' ? record.mediaSig : '';
    } catch { /* closed tab */ }
  }
}
