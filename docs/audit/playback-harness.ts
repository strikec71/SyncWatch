// Browser fixture for real video + real background modules + local Worker.
// Only extension transport APIs are replaced; the application modules are unchanged.
import browser from '../../extension/src/shared/browser';
import { onSendTextMessage, onSendQuickMessage } from '../../extension/src/background/chat';
import { PlayerController } from '../../extension/src/content/player';
import { getSession } from '../../extension/src/background/state';
import { connect } from '../../extension/src/background/connection';
import { onPlayerEvent, onBeat, onBuffering, onAd, onVideoReady } from '../../extension/src/background/sync';
import { onVideoPresence } from '../../extension/src/background/presence';

export async function startPeer(room: string, serverUrl: string) {
  const session = getSession(1);
  session.pageUrl = location.href.split('#')[0];
  const controller = new PlayerController();
  (browser.storage.local.get as any) = async () => ({ settings: { serverUrl, deviceName: 'Browser fixture', autoConnect: true, driftThreshold: 2 } });
  (browser.tabs.get as any) = async () => ({ id: 1, url: location.href });
  (browser.tabs.sendMessage as any) = async (_id: number, msg: any) => {
    switch (msg.kind) {
      case 'apply': controller.applyRemote(msg.action, msg.currentTime, msg.paused, msg.rate, msg.pauseOnly); break;
      case 'buffer-control': controller.applyBufferControl(msg.buffering); break;
      case 'ad-control': controller.applyAdControl(msg.ad); break;
      case 'sync-time': controller.applyDriftCorrection(msg.currentTime, msg.ts, msg.driftThreshold); break;
      case 'get-snapshot': return controller.snapshot();
      case 'pause-local': controller.pauseLocal(); break;
      case 'media-apply': controller.applyMediaSelection(msg.sig); break;
    }
  };
  (browser.runtime.sendMessage as any) = async (msg: any) => {
    switch (msg.kind) {
      case 'player-event': onPlayerEvent(session, msg, 0); break;
      case 'beat': onBeat(session, msg, 0); break;
      case 'buffering': onBuffering(session, msg, 0); break;
      case 'ad': onAd(session, msg, 0); break;
      case 'video-ready': onVideoReady(session, 0); break;
      case 'video-presence': onVideoPresence(1, 0, msg.present); break;
    }
  };
  controller.start();
  await connect(session, room, serverUrl);
  return { session, controller, text: (text: string) => onSendTextMessage(session, text), quick: (code: string) => onSendQuickMessage(session, code), send: (msg: any) => onPlayerEvent(session, msg, 0), buffer: (value: boolean) => onBuffering(session, { kind: 'buffering', buffering: value, currentTime: document.querySelector('video')!.currentTime }, 0) };
}
