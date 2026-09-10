import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadConfig, saveConfig } from '@/shared/storage';
import type { Config } from '@/shared/types';
import './styles.css';

function PopupApp() {
  const [config, setConfig] = useState<Config | null>(null);
  useEffect(() => {
    loadConfig().then(setConfig);
  }, []);

  if (!config) return <div className="popup-shell">Loading…</div>;

  const configured = !!config.serverUrl;
  return (
    <div className="popup-shell">
      <div className="popup-row">
        <strong>WhatsApp Web Translator</strong>
        <span className={configured ? 'popup-pill ok' : 'popup-pill warn'}>
          {configured ? 'configuré' : 'serveur manquant'}
        </span>
      </div>
      <div className="popup-row">
        <span>Serveur</span>
        <span title={config.serverUrl}>{config.serverUrl.replace(/^https?:\/\//, '').slice(0, 28)}</span>
      </div>
      <div className="popup-row">
        <span>Langue</span>
        <span>{config.nativeLang}</span>
      </div>
      <label className="popup-toggle">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => {
            const next = { ...config, enabled: e.target.checked };
            setConfig(next);
            saveConfig({ enabled: e.target.checked });
          }}
        />
        Activée
      </label>
      <button
        type="button"
        className="popup-btn"
        onClick={() => chrome.runtime.openOptionsPage()}
      >
        Ouvrir les réglages
      </button>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
);
