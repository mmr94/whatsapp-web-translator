import { useEffect, useMemo, useRef, useState } from 'react';
import { LANGUAGES, languageLabel } from '@/shared/languages';
import { getActiveChatId } from '../wa';
import { getChatLang, setChatLang, subscribe } from '../store';

interface Props {
  // Re-render when WA changes the active chat (driven by parent observer).
  chatIdSignal: number;
}

export function LanguagePicker({ chatIdSignal }: Props) {
  const chatId = useMemo(() => getActiveChatId(), [chatIdSignal]);
  const [, force] = useState(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => subscribe('chatLangs', () => force((n) => n + 1)), []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const current = chatId ? getChatLang(chatId) : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return LANGUAGES;
    return LANGUAGES.filter(
      (l) =>
        l.code.toLowerCase().includes(q) ||
        l.name.toLowerCase().includes(q) ||
        l.native.toLowerCase().includes(q),
    );
  }, [query]);

  const onSelect = (code: string | null) => {
    if (!chatId) return;
    setChatLang(chatId, code);
    setOpen(false);
    setQuery('');
  };

  const label = current ? current.toUpperCase() : 'Traduire';

  return (
    <div className="wa-translate-picker-host">
      <button
        className="wa-translate-picker-btn"
        data-active={current ? 'true' : 'false'}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={current ? `Mes messages sont traduits en ${languageLabel(current)}` : 'Traduire mes messages dans cette discussion'}
        disabled={!chatId}
      >
        <span aria-hidden>🌐</span>
        <span>{label}</span>
      </button>
      {open ? (
        <div ref={popRef} className="wa-translate-picker-pop">
          <input
            className="wa-translate-picker-search"
            placeholder="Rechercher une langue…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <div className="wa-translate-picker-list">
            {filtered.map((l) => (
              <div
                key={l.code}
                className="wa-translate-picker-item"
                data-selected={current === l.code ? 'true' : 'false'}
                onClick={() => onSelect(l.code)}
              >
                <span>
                  {l.native} <span style={{ opacity: 0.55 }}>· {l.name}</span>
                </span>
                <span style={{ opacity: 0.55, fontSize: 11 }}>{l.code}</span>
              </div>
            ))}
            {filtered.length === 0 ? (
              <div style={{ padding: '12px', opacity: 0.6, fontSize: 12 }}>Aucune langue trouvée</div>
            ) : null}
          </div>
          {current ? (
            <div className="wa-translate-picker-clear" onClick={() => onSelect(null)}>
              Ne plus traduire cette discussion
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
