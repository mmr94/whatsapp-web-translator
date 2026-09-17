import { useEffect, useMemo, useState } from 'react';
import { LANGUAGES } from '@/shared/languages';
import { type Config } from '@/shared/types';
import { loadConfig, saveConfig } from '@/shared/storage';

type Status = { tone: 'ok' | 'err' | ''; text: string };

export function OptionsApp() {
  const [config, setConfig] = useState<Config | null>(null);
  const [status, setStatus] = useState<Status>({ tone: '', text: '' });

  useEffect(() => {
    loadConfig().then(setConfig);
  }, []);

  const setAndSave = useMemo(
    () => (patch: Partial<Config>) => {
      setConfig((previous) => (previous ? { ...previous, ...patch } : previous));
      saveConfig(patch).then(() => {
        setStatus({ tone: 'ok', text: 'Paramètres enregistrés' });
        setTimeout(() => setStatus({ tone: '', text: '' }), 1_200);
      });
    },
    [],
  );

  if (!config) return <div className="opts-shell">Chargement…</div>;

  const authorizeAndTest = async () => {
    try {
      const url = new URL(config.serverUrl);
      const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
      if (!granted) throw new Error('Autorisation refusée pour cette adresse.');
      await saveConfig(config);
      const result = await chrome.runtime.sendMessage({ kind: 'TEST_SERVER' });
      if (!result?.ok) throw new Error(result?.error || 'Test impossible.');
      setStatus({ tone: 'ok', text: `✓ ${result.message}` });
    } catch (error) {
      setStatus({ tone: 'err', text: (error as Error)?.message ?? String(error) });
    }
  };

  return (
    <div className="opts-shell">
      <h1>WhatsApp Web Translator</h1>
      <p className="opts-sub">Traduction privée et transcription des vocaux via votre propre serveur.</p>

      <section className="opts-section">
        <h2>Serveur privé</h2>
        <div className="opts-row">
          <label htmlFor="server-url">Adresse du serveur</label>
          <input id="server-url" type="url" placeholder="https://traduction.example.com" value={config.serverUrl} onChange={(event) => setAndSave({ serverUrl: event.target.value })} />
          <div className="opts-help">Exemple local : <code>http://127.0.0.1:8000</code></div>
        </div>
        <div className="opts-row">
          <label htmlFor="api-token">Jeton d’accès facultatif</label>
          <input id="api-token" type="password" autoComplete="off" value={config.apiToken} onChange={(event) => setAndSave({ apiToken: event.target.value })} />
          <div className="opts-help">Stocké uniquement dans <code>chrome.storage.local</code>.</div>
        </div>
        <div className="opts-row">
          <label htmlFor="health-path">Route de santé</label>
          <input id="health-path" value={config.healthPath} onChange={(event) => setAndSave({ healthPath: event.target.value })} />
        </div>
        <button type="button" className="opts-save" onClick={authorizeAndTest}>Autoriser cette adresse et tester</button>
      </section>

      <section className="opts-section">
        <h2>Traduction</h2>
        <div className="opts-row">
          <label htmlFor="native-lang">Ma langue</label>
          <select id="native-lang" value={config.nativeLang} onChange={(event) => setAndSave({ nativeLang: event.target.value })}>
            {LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.native} ({language.name})</option>)}
          </select>
          <div className="opts-help">Les messages reçus sont traduits dans cette langue.</div>
        </div>
        <div className="opts-row">
          <label htmlFor="translation-protocol">Protocole</label>
          <select id="translation-protocol" value={config.translationProtocol} onChange={(event) => setAndSave({ translationProtocol: event.target.value as Config['translationProtocol'] })}>
            <option value="simple">API simple /v1/translate</option>
            <option value="openai">API compatible OpenAI</option>
          </select>
        </div>
        <div className="opts-row">
          <label htmlFor="translation-path">Route de traduction</label>
          <input id="translation-path" value={config.translationPath} onChange={(event) => setAndSave({ translationPath: event.target.value })} />
          <div className="opts-help">Avec le protocole OpenAI, utilisez normalement <code>/v1/chat/completions</code>.</div>
        </div>
        <div className="opts-row">
          <label htmlFor="translation-model">Modèle de traduction</label>
          <input id="translation-model" placeholder="nllb-200 ou modèle LLM" value={config.translationModel} onChange={(event) => setAndSave({ translationModel: event.target.value })} />
        </div>
        <div className="opts-row">
          <label htmlFor="personality">Consignes de traduction</label>
          <textarea id="personality" value={config.personality} onChange={(event) => setAndSave({ personality: event.target.value })} />
        </div>
      </section>

      <section className="opts-section">
        <h2>Messages vocaux</h2>
        <div className="opts-row">
          <label htmlFor="transcription-path">Route de transcription</label>
          <input id="transcription-path" value={config.transcriptionPath} onChange={(event) => setAndSave({ transcriptionPath: event.target.value })} />
          <div className="opts-help">Format multipart compatible avec <code>/v1/audio/transcriptions</code>.</div>
        </div>
        <div className="opts-row">
          <label htmlFor="transcription-model">Modèle</label>
          <input id="transcription-model" value={config.transcriptionModel} onChange={(event) => setAndSave({ transcriptionModel: event.target.value })} />
        </div>
        <div className="opts-row">
          <label htmlFor="voice-lang">Langue parlée</label>
          <select id="voice-lang" value={config.voiceSourceLang} onChange={(event) => setAndSave({ voiceSourceLang: event.target.value })}>
            <option value="auto">Détection automatique</option>
            {LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.native} ({language.name})</option>)}
          </select>
        </div>
        <label className="opts-toggle"><input type="checkbox" checked={config.autoTranslateVoice} onChange={(event) => setAndSave({ autoTranslateVoice: event.target.checked })} />Traduire automatiquement la transcription dans ma langue</label>
        <label className="opts-toggle"><input type="checkbox" checked={config.autoTranscribeVoice} onChange={(event) => setAndSave({ autoTranscribeVoice: event.target.checked })} />Transcrire automatiquement les nouveaux vocaux reçus</label>
        <div className="opts-help">Les vocaux sont transcrits sans être lus : ils ne sont pas marqués comme écoutés.</div>
        <label className="opts-toggle"><input type="checkbox" checked={config.diarize} onChange={(event) => setAndSave({ diarize: event.target.checked })} />Séparer les locuteurs si le serveur le permet</label>
      </section>

      <section className="opts-section">
        <h2>Activation</h2>
        <label className="opts-toggle"><input type="checkbox" checked={config.enabled} onChange={(event) => setAndSave({ enabled: event.target.checked })} />Activer la traduction des messages</label>
        <div className="opts-help">Rechargez WhatsApp Web après un changement important.</div>
      </section>

      <div className="opts-status" data-tone={status.tone}>{status.text}</div>
    </div>
  );
}
