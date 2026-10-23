import browser from '../shared/browser';
import { allSessions, type Session } from './state';
import { notifyPopup } from './roster';
export const UPDATE_ALARM = 'syncwatch-updates';
const checks = new Map<string, number>();
export function semverGt(remote: string, local: string): boolean {
  if (remote.length > 32 || local.length > 32) return false;
  if (!/^\d+\.\d+\.\d+$/.test(remote) || !/^\d+\.\d+\.\d+$/.test(local)) return false;
  const a = remote.split('.').map(Number), b = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export async function checkUpdates(s: Session): Promise<void> {
  if (!s.serverUrl || Date.now() - (checks.get(s.serverUrl) ?? 0) < 24 * 60 * 60 * 1000) return;
  checks.set(s.serverUrl, Date.now());
  try {
    const url = new URL(s.serverUrl.replace(/^ws/, 'http')); url.pathname = url.pathname.replace(/\/$/, '') + '/version';
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), credentials: 'omit', redirect: 'error' });
    if (!response.ok) return;
    const info = await response.json() as { version?: unknown };
    if (typeof info.version === 'string' && semverGt(info.version, browser.runtime.getManifest().version)) {
      for (const session of allSessions()) if (session.serverUrl === s.serverUrl) { session.updateVersion = info.version; notifyPopup(session); }
    }
  } catch { /* An update check never interrupts viewing. */ }
}
export function startNotifier(): void {
  browser.alarms.create(UPDATE_ALARM, { periodInMinutes: 24 * 60 });
  browser.alarms.onAlarm.addListener(alarm => { if (alarm.name === UPDATE_ALARM) for (const s of allSessions()) void checkUpdates(s); });
}
