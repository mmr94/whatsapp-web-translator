import { loadConfig } from '@/shared/storage';
import type { TranslateRequest, TranslateResult } from '@/shared/types';
import { callTranscriptionServer, callTranslationServer, testServer } from './providers';
import type { RpcMessage, TranscribeRpcRequest, TranslateRpcRequest } from '@/shared/messages';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'wa-translate') return;
  port.onMessage.addListener(async (msg: TranslateRpcRequest | TranscribeRpcRequest) => {
    if (!msg || !['TRANSLATE_REQUEST', 'TRANSCRIBE_REQUEST'].includes(msg.kind)) return;
    try {
      const result = msg.kind === 'TRANSLATE_REQUEST'
        ? await translate(msg.payload)
        : await transcribe(msg.payload);
      const reply: RpcMessage = {
        __waTrans: true,
        kind: msg.kind === 'TRANSLATE_REQUEST' ? 'TRANSLATE_RESULT' : 'TRANSCRIBE_RESULT',
        id: msg.id,
        ok: true,
        result,
      } as RpcMessage;
      port.postMessage(reply);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[wa-translate sw] translate failed:', message);
      const reply: RpcMessage = {
        __waTrans: true,
        kind: msg.kind === 'TRANSLATE_REQUEST' ? 'TRANSLATE_RESULT' : 'TRANSCRIBE_RESULT',
        id: msg.id,
        ok: false,
        error: message,
      } as RpcMessage;
      try {
        port.postMessage(reply);
      } catch {}
    }
  });
});

async function translate(req: TranslateRequest): Promise<TranslateResult> {
  const text = (req.text ?? '').trim();
  if (!text) {
    return { translated: '', source: 'unknown', target: req.target };
  }
  const config = await loadConfig();
  return callTranslationServer(config, req);
}

async function transcribe(req: TranscribeRpcRequest['payload']) {
  const config = await loadConfig();
  return callTranscriptionServer(config, req);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === 'PING_CONFIG') {
    loadConfig().then((c) => {
      sendResponse({
        serverUrl: c.serverUrl,
        configured: !!c.serverUrl,
        nativeLang: c.nativeLang,
      });
    });
    return true;
  }
  if (msg?.kind === 'TEST_SERVER') {
    loadConfig()
      .then(testServer)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error) }));
    return true;
  }
  return false;
});
