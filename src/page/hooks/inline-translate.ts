// Display-time translation of incoming messages, including the history already on screen.
//
// Each rendered bubble carries `data-id` = the message key (`msg.id.id`). We resolve it
// against the active chat's message models, so the text, direction and type come from
// WhatsApp's data layer rather than from CSS classes. The translation is shown under the
// original and never written back into WhatsApp's store: disabling the extension simply
// stops rendering it.

import { activeChat, messageRows } from '../messages';
import { translate } from '../bridge';
import { getChatLang, getConfig, subscribe } from '../store';

const BLOCK_CLASS = 'wa-translate-inline';
const MAX_PARALLEL = 4;
const TIMEOUT_MS = 15_000;

// `${source}\0${target}\0${text}` -> translation ('' when identical or failed)
const cache = new Map<string, string>();
const stats = { installed: false, lastError: null as string | null };

export function getInlineStats() {
  return stats;
}
const inflight = new Set<string>();
let running = 0;
const queue: Array<() => Promise<void>> = [];

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift()!;
    running++;
    job().finally(() => {
      running--;
      pump();
    });
  }
}

export function messageText(msg: any): string {
  if (!msg || msg.id?.fromMe) return '';
  const text = msg.type === 'chat' ? msg.body : msg.caption;
  return typeof text === 'string' ? text.trim() : '';
}

// The block that holds a message's text. Text messages expose `data-pre-plain-text`;
// media captions have no such marker, so we fall back to the deepest element containing
// the text itself (taken from the model), which doesn't depend on markup or classes.
export function textContainer(row: HTMLElement, text: string): HTMLElement | null {
  const marked = row.querySelector<HTMLElement>('[data-pre-plain-text]') ?? row.querySelector<HTMLElement>('.copyable-text');
  if (marked) return marked;

  // Emojis render as <img>, so match a plain-text fragment of the first line.
  const fragments = text.split('\n')[0].split(/\p{Extended_Pictographic}/u).map((f) => f.trim());
  const probe = fragments.sort((a, b) => b.length - a.length)[0]?.slice(0, 24) ?? '';
  if (probe.length < 3) return null;
  let deepest: Element | null = null;
  for (const node of row.querySelectorAll('span, div')) {
    if (!node.classList.contains(BLOCK_CLASS) && node.textContent?.includes(probe)) deepest = node;
  }
  return deepest?.closest<HTMLElement>('div') ?? null;
}

function render(row: HTMLElement, text: string, key: string, translated: string) {
  const container = textContainer(row, text);
  if (!container) return;
  let block = container.querySelector<HTMLElement>(`:scope > .${BLOCK_CLASS}`);
  if (!translated) {
    block?.remove();
    return;
  }
  if (!block) {
    block = document.createElement('div');
    block.className = BLOCK_CLASS;
    container.appendChild(block);
  }
  if (block.dataset.key !== key) {
    block.dataset.key = key;
    const spacer = document.createElement('span');
    spacer.className = `${BLOCK_CLASS}-spacer`;
    spacer.style.width = `${timestampWidth(row)}px`;
    block.replaceChildren(document.createTextNode(translated), spacer);
  }
}

const TIME_RE = /^\d{1,2}[:.h]\d{2}(\s?[ap]\.?m\.?)?$/i;

// WhatsApp floats the time over the bubble's last line and reserves room for it with a
// trailing spacer. Our block becomes the last line, so it needs the same reservation.
function timestampWidth(row: HTMLElement): number {
  for (const node of row.querySelectorAll<HTMLElement>('span, div')) {
    if (node.childElementCount === 0 && TIME_RE.test(node.textContent?.trim() ?? '')) {
      // The meta container also holds edit labels and delivery ticks.
      const meta = node.parentElement?.parentElement ?? node;
      return Math.ceil(Math.max(node.getBoundingClientRect().width, meta.getBoundingClientRect().width)) + 10;
    }
  }
  return 64;
}

function scan() {
  const config = getConfig();
  const main = document.querySelector('#main');
  if (!main) return;
  if (!config.enabled || !config.nativeLang) {
    main.querySelectorAll(`.${BLOCK_CLASS}`).forEach((el) => el.remove());
    return;
  }

  const chat = activeChat();
  const models: any[] = chat?.msgs?.getModelsArray?.() ?? [];
  if (!models.length) return;
  const byKey = new Map<string, any>(models.map((m) => [m?.id?.id, m]));

  const chatId: string | undefined = chat?.id?._serialized;
  const source = (chatId && getChatLang(chatId)) || 'auto';
  const target = config.nativeLang;
  if (source === target) return;

  for (const row of messageRows()) {
    const text = messageText(byKey.get(row.getAttribute('data-id') ?? ''));
    if (text.length < 2) continue;
    const key = `${source}\0${target}\0${text}`;

    const known = cache.get(key);
    if (known !== undefined) {
      render(row, text, key, known);
      continue;
    }
    if (inflight.has(key)) continue;
    inflight.add(key);
    queue.push(async () => {
      try {
        const result = await translate({ text, source, target }, TIMEOUT_MS);
        const translated = result.translated?.trim() ?? '';
        cache.set(key, translated && translated !== text ? translated : '');
        stats.lastError = null;
      } catch (err) {
        // Not cached: the next scan retries once the server is reachable again.
        stats.lastError = err instanceof Error ? err.message : String(err);
        console.warn('[wa-translate] inline translation failed', err);
      } finally {
        inflight.delete(key);
        schedule();
      }
    });
  }
  pump();
}

// setTimeout rather than requestAnimationFrame: rAF is paused while the window is hidden,
// and translations should already be there when the user comes back to it.
let timer: ReturnType<typeof setTimeout> | null = null;
function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    scan();
  }, 120);
}

export function installInlineTranslation(): void {
  // Our own insertions are filtered out so they don't trigger endless rescans.
  new MutationObserver((mutations) => {
    const foreign = mutations.some((m) =>
      [...m.addedNodes, ...m.removedNodes].some(
        (n) => !(n instanceof HTMLElement && n.classList.contains(BLOCK_CLASS)),
      ),
    );
    if (foreign) schedule();
  }).observe(document.body, { childList: true, subtree: true });
  subscribe('config', schedule);
  subscribe('chatLangs', schedule);
  schedule();
  stats.installed = true;
  console.info('[wa-translate] inline translation installed');
}
