import type { Config, TranscribeResult, TranslateResult } from '@/shared/types';
import { DEFAULT_CONFIG } from '@/shared/types';
import { newRpcId } from '@/shared/messages';

const PAGE_TAG = '__wttVoice';
const CACHE_KEY = 'voiceCache';
const VOICE_HINTS = '[data-icon="ptt-status"], [aria-label="Voice message"], [aria-label="Play voice message"]';

type VoiceCache = Record<string, { transcript: string; translation?: string; language?: string; ts: number }>;
type PageResponse = { ok: boolean; blob?: Blob; error?: string };

let config: Config = { ...DEFAULT_CONFIG };
let pageSequence = 0;
const pagePending = new Map<number, (response: PageResponse) => void>();

function askPage(action: string, extra: Record<string, unknown> = {}, timeout = 30_000): Promise<PageResponse> {
  const id = ++pageSequence;
  return new Promise((resolve) => {
    pagePending.set(id, resolve);
    window.postMessage({ [PAGE_TAG]: 'req', id, action, ...extra }, '*');
    setTimeout(() => {
      if (pagePending.delete(id)) resolve({ ok: false, error: 'Délai audio dépassé' });
    }, timeout);
  });
}

function rpc<T>(kind: 'TRANSLATE_REQUEST' | 'TRANSCRIBE_REQUEST', payload: unknown, timeout = 120_000): Promise<T> {
  const id = newRpcId();
  const resultKind = kind === 'TRANSLATE_REQUEST' ? 'TRANSLATE_RESULT' : 'TRANSCRIBE_RESULT';
  return new Promise((resolve, reject) => {
    const listener = (event: MessageEvent) => {
      if (event.source !== window || event.data?.__waTrans !== true) return;
      if (event.data?.kind !== resultKind || event.data?.id !== id) return;
      window.removeEventListener('message', listener);
      clearTimeout(timer);
      if (event.data.ok) resolve(event.data.result as T);
      else reject(new Error(event.data.error || 'Erreur du serveur'));
    };
    const timer = setTimeout(() => {
      window.removeEventListener('message', listener);
      reject(new Error('Le serveur a dépassé le délai de réponse.'));
    }, timeout);
    window.addEventListener('message', listener);
    window.postMessage({ __waTrans: true, kind, id, payload }, '*');
  });
}

function press(element: HTMLElement): void {
  const options = { bubbles: true, cancelable: true, composed: true };
  try {
    element.dispatchEvent(new PointerEvent('pointerdown', options));
    element.dispatchEvent(new MouseEvent('mousedown', options));
    element.dispatchEvent(new PointerEvent('pointerup', options));
    element.dispatchEvent(new MouseEvent('mouseup', options));
  } catch {}
  element.click();
}

const controlIcon = (element: HTMLElement | null) => (element?.textContent || '').trim().toLowerCase();
const isDownload = (element: HTMLElement | null) => /download/.test(controlIcon(element));

function findTransportButton(row: HTMLElement): HTMLElement | null {
  const buttons = [...row.querySelectorAll<HTMLElement>('button')].filter((button) => !button.closest('.wtt-voice'));
  const slider = row.querySelector('[role="slider"]');
  if (slider) {
    const before = buttons.filter((button) => button.compareDocumentPosition(slider) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (before.length) return before[before.length - 1];
  }
  return buttons.find((button) => !/\d\s*[.,]?\d*\s*[x×]/i.test(button.textContent || '')) || null;
}

async function waitFor<T>(probe: () => T | null, timeout = 25_000): Promise<T | null> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function captureAudio(row: HTMLElement, status: (value: string) => void): Promise<Blob> {
  const alive = await askPage('ping', {}, 2_000);
  if (!alive.ok) throw new Error('Rechargez l’onglet WhatsApp Web.');

  let button = findTransportButton(row);
  if (!button) throw new Error('Contrôle du message vocal introuvable.');
  if (isDownload(button)) {
    status('Téléchargement…');
    press(button);
    button = await waitFor(() => {
      const next = findTransportButton(row);
      return next && !isDownload(next) ? next : null;
    });
    if (!button) throw new Error('WhatsApp n’a pas téléchargé ce vocal.');
  }

  const id = ++pageSequence;
  const captured = new Promise<PageResponse>((resolve) => {
    pagePending.set(id, resolve);
    setTimeout(() => {
      if (pagePending.delete(id)) resolve({ ok: false, error: 'Capture audio expirée' });
    }, 35_000);
  });
  window.postMessage({ [PAGE_TAG]: 'req', id, action: 'arm', ms: 38_000 }, '*');
  await new Promise((resolve) => setTimeout(resolve, 0));
  status('Lecture du vocal…');
  press(button);

  const response = await captured;
  await askPage('hold', { ms: 2_000 }, 3_000);
  await askPage('silence', {}, 3_000);
  await askPage('disarm', {}, 3_000);
  if (!response.ok || !response.blob) throw new Error(response.error || 'Capture audio impossible.');
  return response.blob;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function messageId(row: HTMLElement): string {
  const element = row.querySelector('[data-id]') || row.closest('[data-id]');
  return element?.getAttribute('data-id') || `visible:${row.innerText.slice(0, 100)}`;
}

function isVoiceNote(row: HTMLElement): boolean {
  return !!row.querySelector(`${VOICE_HINTS}, audio, [aria-label*="voice message" i], [aria-label*="voice note" i]`);
}

function isOutgoing(row: HTMLElement): boolean {
  const anchor = row.querySelector<HTMLElement>(VOICE_HINTS) || row.firstElementChild as HTMLElement | null;
  if (!anchor) return false;
  const a = anchor.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  return r.width > 0 && (a.left + a.right) / 2 > (r.left + r.right) / 2;
}

async function readCache(id: string) {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  return ((stored[CACHE_KEY] || {}) as VoiceCache)[id] || null;
}

async function writeCache(id: string, value: VoiceCache[string]) {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const cache = (stored[CACHE_KEY] || {}) as VoiceCache;
  cache[id] = value;
  const entries = Object.entries(cache).sort((a, b) => b[1].ts - a[1].ts).slice(0, 600);
  await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(entries) });
}

function makeElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function renderResult(result: HTMLElement, data: VoiceCache[string]) {
  result.replaceChildren();
  if (data.translation) result.append(makeElement('div', 'wtt-voice-translation', data.translation));
  result.append(makeElement('div', data.translation ? 'wtt-voice-original' : '', data.transcript));
  const actions = makeElement('div', 'wtt-voice-actions');
  const copy = makeElement('button', 'wtt-voice-link', 'Copier');
  copy.type = 'button';
  copy.onclick = async () => {
    await navigator.clipboard.writeText(data.translation || data.transcript);
    copy.textContent = 'Copié';
    setTimeout(() => (copy.textContent = 'Copier'), 1_200);
  };
  actions.append(copy);
  result.append(actions);
  result.hidden = false;
}

async function processVoice(row: HTMLElement, button: HTMLButtonElement, status: HTMLElement, result: HTMLElement, force = false) {
  if (row.dataset.wttVoiceBusy === '1') return;
  row.dataset.wttVoiceBusy = '1';
  button.disabled = true;
  status.dataset.error = 'false';
  const id = messageId(row);
  try {
    if (!force) {
      const cached = await readCache(id);
      if (cached) {
        renderResult(result, cached);
        button.hidden = true;
        status.textContent = cached.language || '';
        return;
      }
    }
    const audio = await captureAudio(row, (text) => (status.textContent = text));
    status.textContent = 'Transcription…';
    const transcription = await rpc<TranscribeResult>('TRANSCRIBE_REQUEST', {
      base64: toBase64(await audio.arrayBuffer()),
      mimeType: audio.type || 'audio/ogg',
      language: config.voiceSourceLang,
      diarize: config.diarize,
    });

    let translation = '';
    if (config.autoTranslateVoice && transcription.text) {
      status.textContent = 'Traduction…';
      const translated = await rpc<TranslateResult>('TRANSLATE_REQUEST', {
        text: transcription.text,
        source: transcription.language || 'auto',
        target: config.nativeLang,
      });
      if (translated.translated.trim() !== transcription.text.trim()) translation = translated.translated;
    }
    const data = { transcript: transcription.text, translation, language: transcription.language, ts: Date.now() };
    await writeCache(id, data);
    renderResult(result, data);
    button.hidden = true;
    status.textContent = transcription.language || '';
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Réessayer';
    status.dataset.error = 'true';
    status.textContent = (error as Error)?.message ?? String(error);
  } finally {
    delete row.dataset.wttVoiceBusy;
  }
}

async function attach(row: HTMLElement): Promise<void> {
  row.dataset.wttVoiceReady = '1';
  const host = makeElement('div', 'wtt-voice');
  const bar = makeElement('div', 'wtt-voice-bar');
  const button = makeElement('button', 'wtt-voice-btn', '◉ Transcrire');
  button.type = 'button';
  const status = makeElement('span', 'wtt-voice-status');
  const result = makeElement('div', 'wtt-voice-result');
  result.hidden = true;
  bar.append(button, status);
  host.append(bar, result);
  for (const event of ['click', 'mousedown', 'mouseup', 'pointerdown']) {
    host.addEventListener(event, (e) => e.stopPropagation());
  }
  row.append(host);

  const cached = await readCache(messageId(row));
  if (cached) {
    renderResult(result, cached);
    button.hidden = true;
    status.textContent = cached.language || '';
  }
  button.onclick = () => void processVoice(row, button, status, result, true);
  if (!cached && config.autoTranscribeVoice && !isOutgoing(row)) {
    setTimeout(() => void processVoice(row, button, status, result), 400);
  }
}

function scan(root: ParentNode = document): void {
  const rows = root.querySelectorAll<HTMLElement>('div[role="row"], div[data-id]');
  for (const row of rows) {
    if (row.dataset.wttVoiceReady === '1' && row.querySelector('.wtt-voice')) continue;
    if (!isVoiceNote(row)) continue;
    if (row.parentElement?.closest('div[role="row"]')) continue;
    void attach(row);
  }
}

export async function startVoiceUi(): Promise<void> {
  const stored = await chrome.storage.local.get('config');
  config = { ...DEFAULT_CONFIG, ...(stored.config || {}) };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.config) config = { ...DEFAULT_CONFIG, ...(changes.config.newValue || {}) };
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.[PAGE_TAG] !== 'res') return;
    const resolve = pagePending.get(event.data.id);
    if (resolve) {
      pagePending.delete(event.data.id);
      resolve(event.data as PageResponse);
    }
  });

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  setInterval(() => scan(), 2_000);
  scan();
}
