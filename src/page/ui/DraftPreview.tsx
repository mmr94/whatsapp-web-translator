import { useEffect, useState } from 'react';
import { subscribeComposer, type ComposerState } from '../hooks/composer';
import { languageLabel } from '@/shared/languages';

export function DraftPreview() {
  const [state, setState] = useState<ComposerState | null>(null);

  useEffect(() => subscribeComposer(setState), []);

  if (!state) return null;
  const empty = !state.targetLang || (!state.translation && !state.loading && !state.error);

  return (
    <div className="wa-translate-draft" data-empty={empty ? 'true' : 'false'}>
      <span className="wa-translate-draft-label">
        {state.targetLang ? `Envoyé en ${languageLabel(state.targetLang)}` : 'Aperçu'}
      </span>
      {state.error ? (
        <span className="wa-translate-draft-error">{state.error}</span>
      ) : state.loading ? (
        <span className="wa-translate-draft-loading">Traduction</span>
      ) : (
        <span>{state.translation}</span>
      )}
    </div>
  );
}
