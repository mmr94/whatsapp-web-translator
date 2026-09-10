import type { TranslateRequest, TranslateResult, TranscribeResult } from './types';

export const TAG = '__waTrans';

export type RpcId = string;

export interface TranslateRpcRequest {
  __waTrans: true;
  kind: 'TRANSLATE_REQUEST';
  id: RpcId;
  payload: TranslateRequest;
}

export interface TranslateRpcResponse {
  __waTrans: true;
  kind: 'TRANSLATE_RESULT';
  id: RpcId;
  ok: true;
  result: TranslateResult;
}

export interface TranslateRpcError {
  __waTrans: true;
  kind: 'TRANSLATE_RESULT';
  id: RpcId;
  ok: false;
  error: string;
}

export interface TranscribeRpcRequest {
  __waTrans: true;
  kind: 'TRANSCRIBE_REQUEST';
  id: RpcId;
  payload: {
    base64: string;
    mimeType: string;
    language?: string;
    diarize?: boolean;
  };
}

export interface TranscribeRpcResponse {
  __waTrans: true;
  kind: 'TRANSCRIBE_RESULT';
  id: RpcId;
  ok: true;
  result: TranscribeResult;
}

export interface TranscribeRpcError {
  __waTrans: true;
  kind: 'TRANSCRIBE_RESULT';
  id: RpcId;
  ok: false;
  error: string;
}

export type RpcMessage =
  | TranslateRpcRequest
  | TranslateRpcResponse
  | TranslateRpcError
  | TranscribeRpcRequest
  | TranscribeRpcResponse
  | TranscribeRpcError;

export function newRpcId(): RpcId {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
