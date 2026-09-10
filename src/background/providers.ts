import type { Config, TranslateRequest, TranslateResult, TranscribeResult } from '@/shared/types';
import { buildPrompt, parseModelOutput } from './prompt';

export class ServerError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function endpoint(base: string, path: string): string {
  const root = base.trim().replace(/\/+$/, '');
  const tail = path.trim().startsWith('/') ? path.trim() : `/${path.trim()}`;
  return `${root}${tail}`;
}

function headers(config: Config, json = false): Record<string, string> {
  const out: Record<string, string> = {};
  if (json) out['content-type'] = 'application/json';
  if (config.apiToken.trim()) out.authorization = `Bearer ${config.apiToken.trim()}`;
  return out;
}

async function checkedFetch(url: string, init: RequestInit, timeoutMs = 120_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw new ServerError(response.status, `Serveur ${response.status}${detail ? ` : ${detail}` : ''}`);
    }
    return response;
  } catch (error) {
    if (error instanceof ServerError) throw error;
    if ((error as Error)?.name === 'AbortError') throw new Error('Le serveur a dépassé le délai de réponse.');
    throw new Error(`Serveur inaccessible : ${(error as Error)?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function callTranslationServer(
  config: Config,
  request: TranslateRequest,
): Promise<TranslateResult> {
  if (!config.serverUrl.trim()) throw new Error('Adresse du serveur manquante.');

  if (config.translationProtocol === 'openai') {
    const prompt = buildPrompt(request, config);
    const response = await checkedFetch(
      endpoint(config.serverUrl, config.translationPath),
      {
        method: 'POST',
        headers: headers(config, true),
        body: JSON.stringify({
          model: config.translationModel || 'translator',
          temperature: 0.1,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        }),
      },
      15_000,
    );
    const data = await response.json();
    const raw = String(data?.choices?.[0]?.message?.content ?? '');
    const parsed = parseModelOutput(
      raw,
      prompt.expectsSourcePrefix,
      request.source && request.source !== 'auto' ? request.source : 'unknown',
    );
    return { translated: parsed.translated, source: parsed.source, target: request.target };
  }

  const response = await checkedFetch(
    endpoint(config.serverUrl, config.translationPath),
    {
      method: 'POST',
      headers: headers(config, true),
      body: JSON.stringify({
        text: request.text,
        source: request.source || 'auto',
        target: request.target,
        model: config.translationModel || undefined,
        style: config.personality,
      }),
    },
    15_000,
  );
  const data = await response.json();
  const translated = String(data?.translated_text ?? data?.translated ?? data?.text ?? '').trim();
  if (!translated) throw new Error('Le serveur de traduction a renvoyé une réponse vide.');
  return {
    translated,
    source: String(data?.detected_language ?? data?.source_language ?? data?.source ?? request.source ?? 'unknown'),
    target: request.target,
  };
}

function extensionFor(mimeType: string): string {
  const type = mimeType.toLowerCase();
  if (type.includes('webm')) return 'webm';
  if (type.includes('wav')) return 'wav';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  return 'ogg';
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || 'audio/ogg' });
}

export async function callTranscriptionServer(
  config: Config,
  payload: { base64: string; mimeType: string; language?: string; diarize?: boolean },
): Promise<TranscribeResult> {
  if (!config.serverUrl.trim()) throw new Error('Adresse du serveur manquante.');
  const blob = base64ToBlob(payload.base64, payload.mimeType);
  if (!blob.size) throw new Error('Le message vocal est vide.');

  const form = new FormData();
  form.append('file', blob, `voice.${extensionFor(payload.mimeType)}`);
  form.append('model', config.transcriptionModel || 'large-v3');
  form.append('response_format', 'json');
  if (payload.language && payload.language !== 'auto') form.append('language', payload.language);
  if (payload.diarize) form.append('diarize', 'true');

  const response = await checkedFetch(endpoint(config.serverUrl, config.transcriptionPath), {
    method: 'POST',
    headers: headers(config),
    body: form,
  });
  const data = await response.json();
  const text = String(data?.text ?? data?.transcript ?? '').trim();
  if (!text) throw new Error('Le serveur de transcription a renvoyé une réponse vide.');
  return {
    text,
    language: String(data?.language ?? data?.language_code ?? 'unknown'),
    confidence: typeof data?.confidence === 'number' ? data.confidence : data?.language_probability,
  };
}

export async function testServer(config: Config): Promise<{ ok: true; message: string }> {
  const response = await checkedFetch(
    endpoint(config.serverUrl, config.healthPath),
    { method: 'GET', headers: headers(config) },
    15_000,
  );
  const data = await response.json().catch(() => ({}));
  return { ok: true, message: String(data?.status ?? data?.message ?? 'Serveur prêt') };
}
