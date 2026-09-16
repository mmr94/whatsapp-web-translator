// Resolve rendered message bubbles to WhatsApp's message models.
//
// Every bubble carries `data-id` = `msg.id.id`. Going through the models instead of the
// DOM gives us the real type, direction, text and media keys, independent of CSS classes
// and interface language.

import { tryRequire } from './wa';

export function activeChat(): any | null {
  return tryRequire('WAWebChatCollection')?.ChatCollection?.getActive?.() ?? null;
}

export function activeMessageIndex(): Map<string, any> {
  const models: any[] = activeChat()?.msgs?.getModelsArray?.() ?? [];
  return new Map(models.map((m) => [m?.id?.id, m]));
}

export function findMessage(key: string): any | null {
  const active = activeMessageIndex().get(key);
  if (active) return active;
  const chats: any[] = tryRequire('WAWebChatCollection')?.ChatCollection?.getModelsArray?.() ?? [];
  for (const chat of chats) {
    const hit = chat?.msgs?.getModelsArray?.().find((m: any) => m?.id?.id === key);
    if (hit) return hit;
  }
  return null;
}

export function messageRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#main [data-id]')];
}
