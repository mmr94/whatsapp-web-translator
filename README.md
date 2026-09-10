# WhatsApp Web Translator — Private A40

Extension Chrome personnelle pour traduire les messages WhatsApp Web entrants et
sortants, transcrire les notes vocales et traduire leurs transcriptions via un serveur
privé. Aucun fournisseur d'IA externe n'est codé en dur.

## Fonctionnalités

- traduction automatique des textes reçus vers votre langue ;
- langue de destination configurable par conversation pour les messages envoyés ;
- aperçu de la traduction pendant la saisie ;
- remplacement du texte juste avant l'envoi ;
- bouton `Transcrire` sous chaque note vocale ;
- traduction facultative de la transcription ;
- transcription automatique facultative des nouveaux vocaux reçus ;
- cache local des transcriptions et paramètres dans `chrome.storage.local` ;
- API simple ou endpoint de traduction compatible OpenAI ;
- endpoint de transcription multipart compatible OpenAI.

## Installation de l'extension

```bash
pnpm install
pnpm build
```

Dans Chrome :

1. ouvrir `chrome://extensions` ;
2. activer **Mode développeur** ;
3. cliquer **Charger l'extension non empaquetée** ;
4. sélectionner le dossier `dist/` ;
5. ouvrir les réglages de l'extension ;
6. indiquer l'adresse du serveur, puis cliquer **Autoriser cette adresse et tester** ;
7. recharger `https://web.whatsapp.com`.

Le bouton vert `🌐` près du bouton d'envoi choisit la langue du destinataire pour la
conversation active. Sans langue choisie, vos messages sortants restent inchangés.
Les textes entrants sont traduits vers la langue définie comme **Ma langue**.

Concrètement : ouvrez une conversation, cliquez sur `🌐 Traduire`, recherchez par
exemple `English`, puis choisissez `English (en)`. Ce choix est mémorisé uniquement
pour cette conversation. Rouvrez le même menu et cliquez sur **Effacer la traduction**
pour revenir aux messages non traduits.

## Contrat d'API

### Santé

```http
GET /health
Authorization: Bearer <token facultatif>
```

Réponse :

```json
{"status":"ok"}
```

### Traduction simple

```http
POST /v1/translate
Content-Type: application/json
Authorization: Bearer <token facultatif>
```

```json
{
  "text": "Bonjour",
  "source": "auto",
  "target": "en",
  "model": "facebook/nllb-200-distilled-600M",
  "style": "Translate naturally"
}
```

Réponse acceptée :

```json
{
  "translated_text": "Hello",
  "detected_language": "fr"
}
```

Les champs de réponse `translated`, ou `text`, sont également acceptés. Pour un
serveur LLM compatible OpenAI, choisir **API compatible OpenAI** et utiliser
`/v1/chat/completions` comme route.

### Transcription

```http
POST /v1/audio/transcriptions
Content-Type: multipart/form-data
Authorization: Bearer <token facultatif>
```

Champs : `file`, `model`, `language` facultatif, `diarize` facultatif et
`response_format=json`.

Réponse :

```json
{
  "text": "Le texte du vocal",
  "language": "fr",
  "confidence": 0.98
}
```

## Serveur A40 fourni

Un exemple FastAPI se trouve dans `server-example/`. Il charge :

- `faster-whisper` avec `large-v3` en FP16 pour la transcription ;
- `facebook/nllb-200-distilled-600M` pour la traduction.

```bash
cd server-example
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
WTT_API_TOKEN=change-me uvicorn app:app --host 0.0.0.0 --port 8000
```

Pour un test local sans jeton, omettre `WTT_API_TOKEN`. Pour un accès réseau, utiliser
HTTPS derrière un proxy et définir obligatoirement un jeton long et aléatoire.

Variables utiles :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `WTT_API_TOKEN` | vide | Jeton Bearer requis par l'API |
| `WTT_WHISPER_MODEL` | `large-v3` | Modèle faster-whisper |
| `WTT_TRANSLATION_MODEL` | `facebook/nllb-200-distilled-600M` | Modèle NLLB |
| `WTT_DEVICE` | `cuda` | `cuda` ou `cpu` |
| `WTT_COMPUTE_TYPE` | `float16` | Précision faster-whisper |
| `WTT_ALLOWED_ORIGINS` | `*` | Origines CORS séparées par des virgules |
| `WTT_PRELOAD_MODELS` | `1` | Charge les deux modèles au démarrage |
| `WTT_ASR_CONCURRENCY` | `2` | Transcriptions simultanées sur le GPU |
| `WTT_ASR_QUEUE_SIZE` | `16` | Vocaux en attente avant réponse HTTP 429 |
| `WTT_TRANSLATION_BATCH_SIZE` | `16` | Messages regroupés dans un batch NLLB |
| `WTT_TRANSLATION_BATCH_WAIT_MS` | `20` | Fenêtre de micro-batching |
| `WTT_TRANSLATION_QUEUE_SIZE` | `128` | Traductions en attente avant HTTP 429 |
| `WTT_QUEUE_TIMEOUT_SECONDS` | `180` | Temps maximal passé dans une file |
| `WTT_TRANSLATION_BEAMS` | `2` | Qualité/débit de génération NLLB |

### Concurrence sur une A40

Le serveur charge une seule copie de chaque modèle par processus. Le chargement est
protégé contre les doubles initialisations concurrentes. Les traductions arrivant au
même moment sont regroupées par paire de langues et traitées en micro-batches. Pour
Whisper, `num_workers` et une file bornée permettent plusieurs transcriptions avec une
limite explicite de mémoire.

Conserver **un seul worker Uvicorn** : plusieurs processus chargeraient plusieurs copies
des modèles dans la VRAM. Pour davantage de débit, augmenter progressivement
`WTT_ASR_CONCURRENCY` (2, puis 3 ou 4) en surveillant la VRAM et la latence. Les files
bornées renvoient HTTP 429 lorsqu'elles sont pleines au lieu de saturer la machine.

## Limites et sécurité

- L'option de transcription automatique peut marquer les vocaux comme écoutés.
- WhatsApp modifie régulièrement son interface et ses modules internes. Une mise à jour
  WhatsApp peut nécessiter d'ajuster les hooks ou les sélecteurs.
- Cette extension est non officielle et réservée à un usage personnel. Les hooks internes
  de WhatsApp peuvent être contraires à ses conditions d'utilisation.
- Le jeton reste dans le profil Chrome, mais toute personne ayant accès au profil peut
  potentiellement le récupérer.
- N'exposez jamais le serveur GPU directement à Internet sans TLS, authentification et
  limitation de débit.

## Sources et licences

La partie texte est dérivée de `purpshell/wa-web-translate` et la stratégie de capture
audio de `ayazalam/whatsapp-voice-note-transcriber`, deux projets sous licence MIT.
Voir `THIRD_PARTY_NOTICES.md` et `LICENSE`.
