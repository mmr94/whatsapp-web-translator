import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadConfig, saveConfig } from '@/shared/storage';
import type { Config } from '@/shared/types';
import { formatReport, HEALTH_KEY, type HealthReport, type HealthStatus } from '@/shared/health';
import './styles.css';

type ServerState = { status: HealthStatus | 'pending'; detail: string };

const STATUS_LABEL: Record<HealthStatus | 'pending', string> = {
  ok: 'OK',
  degraded: 'Secours',
  down: 'En panne',
  idle: 'En attente',
  pending: 'Test…',
};

function ago(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'à l’instant';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `il y a ${minutes} min` : `il y a ${Math.round(minutes / 60)} h`;
}

function Row({ label, status, detail }: { label: string; status: HealthStatus | 'pending'; detail: string }) {
  return (
    <li className="health-row" data-status={status}>
      <span className="health-dot" aria-hidden />
      <div className="health-text">
        <div className="health-label">
          {label}
          <span className="health-state">{STATUS_LABEL[status]}</span>
        </div>
        <div className="health-detail">{detail}</div>
      </div>
    </li>
  );
}

function PopupApp() {
  const [config, setConfig] = useState<Config | null>(null);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [server, setServer] = useState<ServerState>({ status: 'pending', detail: 'Connexion au serveur…' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadConfig().then(setConfig);
    chrome.storage.local.get(HEALTH_KEY).then((stored) => setReport((stored[HEALTH_KEY] as HealthReport) ?? null));
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[HEALTH_KEY]) setReport(changes[HEALTH_KEY].newValue ?? null);
    };
    chrome.storage.onChanged.addListener(onChange);

    const started = performance.now();
    chrome.runtime
      .sendMessage({ kind: 'SELF_TEST' })
      .then((result) => {
        const ms = Math.round(performance.now() - started);
        setServer(
          result?.ok
            ? { status: 'ok', detail: `${result.message} en ${ms} ms` }
            : { status: 'down', detail: result?.error || 'Test impossible' },
        );
      })
      .catch((error) => setServer({ status: 'down', detail: error?.message ?? String(error) }));

    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  if (!config) return <div className="popup-shell">Chargement…</div>;

  const copy = async () => {
    const text = formatReport(report, [`[${server.status}] Serveur — ${server.detail}`]);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div className="popup-shell">
      <div className="popup-row">
        <strong>WhatsApp Web Translator</strong>
        <label className="popup-toggle">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => {
              setConfig({ ...config, enabled: e.target.checked });
              saveConfig({ enabled: e.target.checked });
            }}
          />
          Activée
        </label>
      </div>

      <ul className="health-list">
        <Row label="Serveur" status={server.status} detail={server.detail} />
        {report ? (
          report.checks.map((c) => <Row key={c.id} label={c.label} status={c.status} detail={c.detail} />)
        ) : (
          <Row label="WhatsApp Web" status="idle" detail="Ouvrez WhatsApp Web pour lancer les vérifications" />
        )}
      </ul>

      {report ? (
        <div className="health-meta">
          Vérifié {ago(report.checkedAt)}
          {report.waVersion ? ` · WhatsApp ${report.waVersion}` : ''}
        </div>
      ) : null}

      <div className="popup-actions">
        <button type="button" className="popup-btn secondary" onClick={copy}>
          {copied ? 'Copié' : 'Copier le diagnostic'}
        </button>
        <button type="button" className="popup-btn" onClick={() => chrome.runtime.openOptionsPage()}>
          Réglages
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
);
