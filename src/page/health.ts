// Page-world self-checks. Each check probes one capability against the live WhatsApp
// session and reports ok / degraded (running on a fallback) / down / idle. Results are
// posted to the content script, which stores them and updates the toolbar badge, so a
// WhatsApp release that breaks something is visible immediately instead of failing silently.

import { HEALTH_TAG, type HealthCheck, type HealthReport } from '@/shared/health';
import { getConfig } from './store';
import { tryRequire } from './wa';
import { activeChat, activeMessageIndex, messageRows } from './messages';
import { getSendHookState } from './hooks/send';
import { getInlineStats, messageText, textContainer } from './hooks/inline-translate';
import { findComposer, PICKER_HOST_ID } from './ui/mount';

const INTERVAL_MS = 5_000;
const HEARTBEAT_MS = 60_000;
const VOICE_TYPES = new Set(['ptt', 'audio']);

const check = (id: string, label: string, status: HealthCheck['status'], detail: string): HealthCheck => ({
  id,
  label,
  status,
  detail,
});

function checkWhatsApp(): HealthCheck {
  const collection = tryRequire('WAWebChatCollection')?.ChatCollection;
  if (typeof collection?.getActive !== 'function') {
    return check('whatsapp', 'Accès à WhatsApp', 'down', 'WAWebChatCollection.ChatCollection.getActive introuvable');
  }
  return check('whatsapp', 'Accès à WhatsApp', 'ok', 'Modules internes accessibles');
}

function checkMessages(): HealthCheck {
  const label = 'Lecture des messages';
  if (!activeChat()) return check('messages', label, 'idle', 'Aucune discussion ouverte');
  const rows = messageRows();
  if (!rows.length) return check('messages', label, 'idle', 'Aucun message affiché');
  const index = activeMessageIndex();
  const matched = rows.filter((row) => index.has(row.getAttribute('data-id') ?? '')).length;
  const detail = `${matched}/${rows.length} bulles reliées à leur message`;
  if (matched === rows.length) return check('messages', label, 'ok', detail);
  // A few unmatched rows are normal while history loads; most unmatched means data-id changed.
  return check('messages', label, matched / rows.length >= 0.7 ? 'ok' : matched ? 'degraded' : 'down', detail);
}

function checkIncoming(): HealthCheck {
  const label = 'Traduction des messages reçus';
  const stats = getInlineStats();
  if (!stats.installed) return check('incoming', label, 'down', 'Non installée (modules WhatsApp manquants)');
  if (!getConfig().enabled) return check('incoming', label, 'idle', 'Traduction désactivée');
  if (stats.lastError) return check('incoming', label, 'degraded', `Dernière erreur : ${stats.lastError}`);
  const index = activeMessageIndex();
  // Skip bubbles WhatsApp hasn't drawn yet (virtualized off-screen rows are empty shells).
  const textRows = messageRows().filter((row) => {
    const text = messageText(index.get(row.getAttribute('data-id') ?? ''));
    return text && row.innerText.includes(text.slice(0, 12));
  });
  if (!textRows.length) return check('incoming', label, 'idle', 'Aucun message reçu affiché');
  const placeable = textRows.filter((row) => textContainer(row)).length;
  const detail = `${placeable}/${textRows.length} messages où la traduction peut s’afficher`;
  if (placeable === textRows.length) return check('incoming', label, 'ok', detail);
  return check('incoming', label, placeable ? 'degraded' : 'down', detail);
}

function checkOutgoing(): HealthCheck {
  const label = 'Traduction des messages envoyés';
  const { chat, lastError } = getSendHookState();
  if (!chat.installed) return check('outgoing', label, 'down', 'Aucune fonction d’envoi trouvée');
  if (lastError) return check('outgoing', label, 'degraded', `Dernière erreur : ${lastError}`);
  if (chat.fallback) return check('outgoing', label, 'degraded', `Secours actif : ${chat.installed}`);
  return check('outgoing', label, 'ok', chat.installed);
}

function checkPicker(): HealthCheck {
  const label = 'Bouton de langue';
  if (!findComposer()?.closest('#main')) return check('picker', label, 'idle', 'Aucune zone de saisie affichée');
  if (document.getElementById(PICKER_HOST_ID)?.isConnected) return check('picker', label, 'ok', 'Affiché près du bouton d’envoi');
  return check('picker', label, 'down', 'Zone de saisie trouvée mais bouton non placé');
}

function checkVoice(): HealthCheck {
  const label = 'Vocaux';
  const index = activeMessageIndex();
  const voices = [...index.values()].filter((m) => VOICE_TYPES.has(m?.type));
  if (!voices.length) return check('voice', label, 'idle', 'Aucun vocal dans la discussion ouverte');
  const withKeys = voices.filter((m) => (m.directPath ?? m.mediaData?.directPath) && (m.mediaKey ?? m.mediaData?.mediaKey));
  const tagged = document.querySelectorAll('#main [data-wtt-voice]').length;
  const detail = `${withKeys.length}/${voices.length} vocaux téléchargeables, ${tagged} bouton(s) affiché(s)`;
  if (!crypto?.subtle) return check('voice', label, 'down', 'WebCrypto indisponible');
  if (withKeys.length === voices.length) return check('voice', label, 'ok', detail);
  return check('voice', label, withKeys.length ? 'degraded' : 'down', detail);
}

function runChecks(): HealthReport {
  const checks: HealthCheck[] = [];
  for (const probe of [checkWhatsApp, checkMessages, checkIncoming, checkOutgoing, checkPicker, checkVoice]) {
    try {
      checks.push(probe());
    } catch (err) {
      checks.push(check(probe.name, probe.name, 'down', `Vérification en erreur : ${(err as Error)?.message ?? err}`));
    }
  }
  return { checkedAt: Date.now(), waVersion: window.Debug?.VERSION ?? '', checks };
}

export function installHealthChecks(): void {
  let last = '';
  let lastPostedAt = 0;
  const publish = () => {
    const report = runChecks();
    // Post on change, plus a heartbeat so "checked N minutes ago" stays truthful.
    const signature = JSON.stringify(report.checks);
    if (signature === last && report.checkedAt - lastPostedAt < HEARTBEAT_MS) return;
    last = signature;
    lastPostedAt = report.checkedAt;
    window.postMessage({ [HEALTH_TAG]: report }, '*');
  };
  publish();
  setInterval(publish, INTERVAL_MS);
}
