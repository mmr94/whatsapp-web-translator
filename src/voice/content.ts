import type { Config, TranscribeResult, TranslateResult } from '@/shared/types';
import { DEFAULT_CONFIG } from '@/shared/types';
import { newRpcId } from '@/shared/messages';
import { languageLabel } from '@/shared/languages';

// Voice-note bubbles are tagged by the page world (`data-wtt-voice="in|out"`) from
// WhatsApp's message models; the page world fetches and decrypts the audio silently.

const PAGE_TAG = '__wttVoice';
const CACHE_KEY = 'voiceCache';
const ROW_SELECTOR = '#main [data-id][data-wtt-voice]';

type VoiceEntry = { transcript: string; translation?: string; language?: string; ts: number };
type VoiceCache = Record<string, VoiceEntry>;
type PageResponse = { ok: boolean; buffer?: ArrayBuffer; mimeType?: string; error?: string };

let config: Config = { ...DEFAULT_CONFIG };
let pageSequence = 0;
const pagePending = new Map<number, (response: PageResponse) => void>();

function askPage(action: string, extra: Record<string, unknown> = {}, timeout = 60_000): Promise<PageResponse> {
  const id = ++pageSequence;
  return new Promise((resolve) => {
    pagePending.set(id, resolve);
    window.postMessage({ [PAGE_TAG]: 'req', id, action, ...extra }, '*');
    setTimeout(() => {
      if (pagePending.delete(id)) resolve({ ok: false, error: 'WhatsApp ne répond pas. Rechargez la page.' });
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

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function readCache(id: string): Promise<VoiceEntry | null> {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  return ((stored[CACHE_KEY] || {}) as VoiceCache)[id] || null;
}

async function writeCache(id: string, value: VoiceEntry) {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const cache = (stored[CACHE_KEY] || {}) as VoiceCache;
  cache[id] = value;
  const entries = Object.entries(cache).sort((a, b) => b[1].ts - a[1].ts).slice(0, 600);
  await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(entries) });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

// The bubble is the first descendant painted as a rounded card. Detected from computed
// style rather than class names, which WhatsApp regenerates on every release.
function findBubble(row: HTMLElement): HTMLElement {
  const queue: HTMLElement[] = [...(row.children as HTMLCollectionOf<HTMLElement>)];
  while (queue.length) {
    const node = queue.shift()!;
    const style = getComputedStyle(node);
    const painted = !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(style.backgroundColor);
    if (painted && parseFloat(style.borderTopLeftRadius) > 0 && node.offsetWidth >= 120) return node;
    queue.push(...(node.children as HTMLCollectionOf<HTMLElement>));
  }
  return row;
}

interface VoiceUi {
  host: HTMLElement;
  setIdle(label?: string): void;
  setBusy(text: string): void;
  setError(text: string): void;
  setResult(entry: VoiceEntry): void;
}

function buildUi(onRun: () => void): VoiceUi {
  const host = el('div', 'wtt-voice');
  for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  const bar = el('div', 'wtt-voice-bar');
  const button = el('button', 'wtt-chip', 'Transcrire');
  button.type = 'button';
  button.onclick = onRun;
  const status = el('span', 'wtt-voice-status');
  bar.append(button, status);
  const result = el('div', 'wtt-voice-result');
  host.append(bar, result);

  const show = (state: string) => (host.dataset.state = state);

  return {
    host,
    setIdle(label = 'Transcrire') {
      show('idle');
      button.textContent = label;
      button.disabled = false;
      status.textContent = '';
    },
    setBusy(text) {
      show('busy');
      button.disabled = true;
      status.textContent = text;
    },
    setError(text) {
      show('error');
      button.textContent = 'Réessayer';
      button.disabled = false;
      status.textContent = text;
    },
    setResult(entry) {
      show('done');
      result.replaceChildren();
      const main = el('div', 'wtt-voice-text', entry.translation || entry.transcript);
      result.append(main);

      const meta = el('div', 'wtt-voice-meta');
      const lang = entry.language && entry.language !== 'unknown' ? languageLabel(entry.language) : '';
      if (entry.translation) {
        const toggle = el('button', 'wtt-link', 'Voir l’original');
        toggle.type = 'button';
        const original = el('div', 'wtt-voice-original', entry.transcript);
        original.hidden = true;
        toggle.onclick = () => {
          original.hidden = !original.hidden;
          toggle.textContent = original.hidden ? 'Voir l’original' : 'Masquer l’original';
        };
        meta.append(el('span', 'wtt-voice-lang', lang ? `Traduit · ${lang}` : 'Traduit'), toggle);
        result.append(meta, original);
      } else {
        if (lang) meta.append(el('span', 'wtt-voice-lang', lang));
        result.append(meta);
      }
      const copy = el('button', 'wtt-link', 'Copier');
      copy.type = 'button';
      copy.onclick = async () => {
        await navigator.clipboard.writeText(entry.translation || entry.transcript);
        copy.textContent = 'Copié';
        setTimeout(() => (copy.textContent = 'Copier'), 1_200);
      };
      const redo = el('button', 'wtt-link', 'Retranscrire');
      redo.type = 'button';
      redo.onclick = onRun;
      meta.append(copy, redo);
    },
  };
}

async function transcribe(key: string, ui: VoiceUi) {
  try {
    ui.setBusy('Récupération de l’audio…');
    const audio = await askPage('fetch', { key });
    if (!audio.ok || !audio.buffer) throw new Error(audio.error || 'Audio inaccessible.');

    ui.setBusy('Transcription…');
    const transcription = await rpc<TranscribeResult>('TRANSCRIBE_REQUEST', {
      base64: toBase64(audio.buffer),
      mimeType: audio.mimeType || 'audio/ogg',
      language: config.voiceSourceLang,
      diarize: config.diarize,
    });

    let translation = '';
    const spoken = transcription.language;
    if (config.autoTranslateVoice && transcription.text && spoken !== config.nativeLang) {
      ui.setBusy('Traduction…');
      const translated = await rpc<TranslateResult>('TRANSLATE_REQUEST', {
        text: transcription.text,
        source: spoken && spoken !== 'unknown' ? spoken : 'auto',
        target: config.nativeLang,
      });
      if (translated.translated.trim() !== transcription.text.trim()) translation = translated.translated;
    }

    const entry: VoiceEntry = { transcript: transcription.text, translation, language: spoken, ts: Date.now() };
    await writeCache(key, entry);
    ui.setResult(entry);
  } catch (error) {
    ui.setError((error as Error)?.message ?? String(error));
  }
}

const mounted = new WeakMap<HTMLElement, VoiceUi>();
const busy = new Set<string>();

async function attach(row: HTMLElement) {
  const key = row.getAttribute('data-id');
  if (!key) return;
  const existing = mounted.get(row);
  if (existing?.host.isConnected) return;

  const run = () => {
    if (busy.has(key)) return;
    busy.add(key);
    void transcribe(key, ui).finally(() => busy.delete(key));
  };
  const ui = buildUi(run);
  mounted.set(row, ui);
  findBubble(row).append(ui.host);

  const cached = await readCache(key);
  if (cached) ui.setResult(cached);
  else ui.setIdle();

  if (!cached && config.autoTranscribeVoice && row.dataset.wttVoice === 'in') run();
}

function scan() {
  for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) void attach(row);
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

  // setTimeout, not requestAnimationFrame: rAF is paused while the window is hidden.
  let timer: ReturnType<typeof setTimeout> | null = null;
  new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      scan();
    }, 200);
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-wtt-voice'] });
  scan();
}
