// Hook the outgoing-text-message send so we can replace the body with a translation
// (and optionally include the original) before WhatsApp encodes/transmits it.
//
// The exact module/function name has shifted across WhatsApp Web versions. Candidates are
// grouped by purpose and tried in order: only the first one found in a group is hooked, so
// a message can never be translated twice by a primary and a fallback.

import { tryRequire } from '../wa';
import { translate } from '../bridge';
import { getChatLang, getConfig } from '../store';
import { getLanguage } from '@/shared/languages';

interface Candidate {
  module: string;
  function: string;
  bodyArgIndex: number;
  chatArgIndex: number;
}

// Verified live against current WhatsApp Web (compose flow in WAWebComposeBox.react):
//   o("WAWebSendTextMsgChatAction").sendTextMsgToChat(chat, body, options)
//   o("WAWebNewsletterSendMsgAction").sendNewsletterTextMsg(chat, body, options)
const GROUPS: Record<'chat' | 'newsletter', Candidate[]> = {
  chat: [
    { module: 'WAWebSendTextMsgChatAction', function: 'sendTextMsgToChat', bodyArgIndex: 1, chatArgIndex: 0 },
    // Fallback if WhatsApp renames the primary entry point.
    { module: 'WAWebSendTextMsgChatAction', function: 'addAndSendTextMsg', bodyArgIndex: 1, chatArgIndex: 0 },
  ],
  newsletter: [
    { module: 'WAWebNewsletterSendMsgAction', function: 'sendNewsletterTextMsg', bodyArgIndex: 1, chatArgIndex: 0 },
  ],
};

export interface SendHookState {
  chat: { installed: string | null; fallback: boolean };
  newsletter: { installed: string | null; fallback: boolean };
  lastError: string | null;
}

const state: SendHookState = {
  chat: { installed: null, fallback: false },
  newsletter: { installed: null, fallback: false },
  lastError: null,
};

export function getSendHookState(): SendHookState {
  return state;
}

export function installSendHook(): void {
  for (const group of ['chat', 'newsletter'] as const) {
    const candidates = GROUPS[group];
    const index = candidates.findIndex((c) => typeof tryRequire(c.module)?.[c.function] === 'function');
    if (index < 0) {
      console.warn(`[wa-translate] no ${group} send function found; outbound translation disabled there`);
      continue;
    }
    const c = candidates[index];
    const mod = tryRequire(c.module);
    const orig = mod[c.function].bind(mod);
    mod[c.function] = async (...args: any[]) => {
      try {
        const next = await maybeRewrite(args, c);
        state.lastError = null;
        return orig(...next);
      } catch (err) {
        state.lastError = err instanceof Error ? err.message : String(err);
        console.warn(`[wa-translate] ${c.module}.${c.function} rewrite failed:`, err);
        return orig(...args);
      }
    };
    state[group] = { installed: `${c.module}.${c.function}`, fallback: index > 0 };
    console.info(`[wa-translate] send hook installed on ${c.module}.${c.function}`);
  }
}

async function maybeRewrite(args: any[], c: Candidate): Promise<any[]> {
  const config = getConfig();
  if (!config.enabled) return args;

  const chat = args[c.chatArgIndex];
  const chatId: string | null = chat?.id?._serialized ?? null;
  if (!chatId) return args;

  const targetLang = getChatLang(chatId);
  if (!targetLang) return args;

  const body = args[c.bodyArgIndex];
  if (typeof body !== 'string' || !body.trim()) return args;

  const result = await translate({
    text: body,
    source: config.nativeLang || 'auto',
    target: targetLang,
  });
  if (!result.translated) return args;
  if (result.translated.trim() === body.trim()) return args;

  let finalBody = result.translated;
  if (config.sendBoth) {
    const targetName = getLanguage(targetLang)?.code ?? targetLang;
    const sourceCode = result.source && result.source !== 'unknown' ? result.source : config.nativeLang;
    const sourceName = getLanguage(sourceCode)?.code ?? sourceCode;
    finalBody = `${targetName}: ${result.translated}\n-----\n${sourceName}: ${body}`;
  }

  const next = args.slice();
  next[c.bodyArgIndex] = finalBody;
  return next;
}
