import type { LanguageCode } from './languages';

export type TranslationProtocol = 'simple' | 'openai';

export interface Config {
  nativeLang: LanguageCode;
  serverUrl: string;
  apiToken: string;
  translationProtocol: TranslationProtocol;
  translationPath: string;
  transcriptionPath: string;
  healthPath: string;
  translationModel: string;
  transcriptionModel: string;
  personality: string;
  sendBoth: boolean;
  enabled: boolean;
  autoTranscribeVoice: boolean;
  autoTranslateVoice: boolean;
  voiceSourceLang: LanguageCode | 'auto';
  diarize: boolean;
}

export const DEFAULT_CONFIG: Config = {
  nativeLang: 'fr',
  serverUrl: __DEFAULT_SERVER_URL__,
  apiToken: '',
  translationProtocol: 'simple',
  translationPath: '/v1/translate',
  transcriptionPath: '/v1/audio/transcriptions',
  healthPath: '/health',
  translationModel: '',
  transcriptionModel: 'large-v3',
  personality: 'Translate naturally and idiomatically. Match the tone of the original message (casual chat stays casual, formal stays formal). Preserve emojis. Do not add explanations.',
  sendBoth: false,
  enabled: true,
  autoTranscribeVoice: false,
  autoTranslateVoice: true,
  voiceSourceLang: 'auto',
  diarize: false,
};

// Subset of the config exposed to the MAIN world. WhatsApp's own scripts share that
// world, so the server address and token must never be posted there.
export type PageConfig = Omit<Config, 'apiToken' | 'serverUrl'>;

export function toPageConfig({ apiToken: _token, serverUrl: _url, ...rest }: Config): PageConfig {
  return rest;
}

export interface ChatLangMap {
  [chatId: string]: LanguageCode;
}

export interface TranslateRequest {
  text: string;
  source?: LanguageCode | 'auto';
  target: LanguageCode;
}

export interface TranslateResult {
  translated: string;
  source: LanguageCode | 'unknown';
  target: LanguageCode;
}

export interface TranscribeResult {
  text: string;
  language: LanguageCode | 'unknown';
  confidence?: number;
}
