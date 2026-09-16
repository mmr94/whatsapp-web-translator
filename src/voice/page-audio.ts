// Page-world side of voice transcription.
//
// 1. Tags voice-note bubbles with `data-wtt-voice="in|out"` from the message model, so the
//    content script never has to guess from icons or localized labels.
// 2. Fetches a voice note's audio straight from WhatsApp's media CDN and decrypts it with
//    the message's media key. Nothing is played: the note stays silent and is not marked
//    as listened to.

import { tryRequire } from '@/page/wa';
import { activeMessageIndex, findMessage, messageRows } from '@/page/messages';

const TAG = '__wttVoice';
const VOICE_TYPES = new Set(['ptt', 'audio']);

function tagRows() {
  const index = activeMessageIndex();
  if (!index.size) return;
  for (const row of messageRows()) {
    const msg = index.get(row.getAttribute('data-id') ?? '');
    if (!msg || !VOICE_TYPES.has(msg.type)) continue;
    const dir = msg.id?.fromMe ? 'out' : 'in';
    if (row.dataset.wttVoice !== dir) row.dataset.wttVoice = dir;
  }
}

// WhatsApp media encryption (stable across releases): HKDF-SHA256(mediaKey, info) expands
// to iv(16) | cipherKey(32) | macKey(32); the CDN file is AES-256-CBC ciphertext followed by
// the first 10 bytes of HMAC-SHA256(macKey, iv | ciphertext).
const MEDIA_HOST = 'https://mmg.whatsapp.net';
const HKDF_INFO: Record<string, string> = { ptt: 'WhatsApp Audio Keys', audio: 'WhatsApp Audio Keys' };

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

async function downloadAndDecrypt(msg: any): Promise<ArrayBuffer> {
  const response = await fetch(`${MEDIA_HOST}${msg.directPath}`);
  if (!response.ok) throw new Error(`CDN ${response.status}`);
  const encrypted = new Uint8Array(await response.arrayBuffer());

  const baseKey = await crypto.subtle.importKey('raw', fromBase64(msg.mediaKey), 'HKDF', false, ['deriveBits']);
  const expanded = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(HKDF_INFO[msg.type]) },
      baseKey,
      112 * 8,
    ),
  );
  const iv = expanded.slice(0, 16);
  const ciphertext = encrypted.slice(0, -10);
  const mac = encrypted.slice(-10);

  const macKey = await crypto.subtle.importKey('raw', expanded.slice(48, 80), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = new Uint8Array(iv.length + ciphertext.length);
  signed.set(iv);
  signed.set(ciphertext, iv.length);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', macKey, signed)).slice(0, 10);
  if (!expected.every((byte, i) => byte === mac[i])) throw new Error('signature du média invalide');

  const cipherKey = await crypto.subtle.importKey('raw', expanded.slice(16, 48), 'AES-CBC', false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cipherKey, ciphertext);
}

// WhatsApp's downloader expects a performance logger; any call on it is a no-op here.
const noopLogger: any = new Proxy(function () {}, {
  get: () => noopLogger,
  apply: () => noopLogger,
});

async function downloadAudio(msg: any): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
  // Media fields live on the message model; `mediaData` only mirrors some of them.
  const field = (name: string) => msg[name] ?? msg.mediaData?.[name];
  const mimeType = String(field('mimetype') || 'audio/ogg').split(';')[0];
  const errors: string[] = [];

  // 1. Silent CDN download + decryption: depends only on the message's media fields.
  if (field('directPath') && field('mediaKey')) {
    try {
      const buffer = await downloadAndDecrypt({
        type: msg.type,
        directPath: field('directPath'),
        mediaKey: field('mediaKey'),
      });
      if (buffer.byteLength) return { buffer, mimeType };
      errors.push('fichier vide');
    } catch (err) {
      errors.push((err as Error)?.message ?? String(err));
    }
  } else {
    errors.push('clés du média absentes');
  }

  // 2. Fallback: WhatsApp's internal downloader.
  const manager = tryRequire('WAWebDownloadManager')?.downloadManager;
  if (typeof manager?.downloadAndMaybeDecrypt === 'function') {
    try {
      const buffer: ArrayBuffer = await manager.downloadAndMaybeDecrypt({
        directPath: field('directPath'),
        encFilehash: field('encFilehash'),
        filehash: field('filehash'),
        mediaKey: field('mediaKey'),
        mediaKeyTimestamp: field('mediaKeyTimestamp'),
        type: msg.type,
        mimetype: field('mimetype'),
        signal: new AbortController().signal,
        downloadQpl: noopLogger,
      });
      // WhatsApp may keep this buffer for playback: hand out a copy.
      if (buffer?.byteLength) return { buffer: buffer.slice(0), mimeType };
      errors.push('téléchargeur interne vide');
    } catch (err) {
      errors.push((err as Error)?.message ?? String(err));
    }
  }
  throw new Error(`Audio inaccessible (${errors.join(' ; ')})`);
}

export function installVoiceCaptureBridge(): void {
  const marker = '__wttVoiceBridgeInstalled';
  if ((window as unknown as Record<string, unknown>)[marker]) return;
  (window as unknown as Record<string, unknown>)[marker] = true;

  let timer: ReturnType<typeof setTimeout> | null = null;
  new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      tagRows();
    }, 150);
  }).observe(document.body, { childList: true, subtree: true });

  const reply = (id: number, payload: Record<string, unknown>, transfer: Transferable[] = []) => {
    window.postMessage({ [TAG]: 'res', id, ...payload }, '*', transfer);
  };

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.[TAG] !== 'req') return;
    const { id, action, key } = event.data as { id: number; action: string; key?: string };
    if (action === 'ping') return reply(id, { ok: true });
    if (action !== 'fetch' || !key) return;
    try {
      const msg = findMessage(key);
      if (!msg) throw new Error('Message vocal introuvable.');
      const { buffer, mimeType } = await downloadAudio(msg);
      reply(id, { ok: true, buffer, mimeType }, [buffer]);
    } catch (err) {
      reply(id, { ok: false, error: (err as Error)?.message ?? String(err) });
    }
  });
}
