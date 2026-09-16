# WhatsApp Web Translator — Private A40

Extension Chrome personnelle pour traduire les messages WhatsApp Web entrants et
sortants, transcrire les notes vocales et traduire leurs transcriptions via un serveur
privé. Aucun fournisseur d'IA externe n'est codé en dur.

## Fonctionnalités

- traduction des messages reçus affichée sous l'original, historique compris ;
- langue de destination configurable par conversation pour les messages envoyés ;
- aperçu de la traduction pendant la saisie ;
- remplacement du texte juste avant l'envoi ;
- bouton `Transcrire` dans chaque note vocale : l'audio est téléchargé et déchiffré en
  silence, sans lecture et sans marquer le vocal comme écouté ;
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

## Stabilité et diagnostic

L'extension s'appuie sur l'interne de WhatsApp Web, qui change sans prévenir. Pour limiter
la casse et la rendre visible :

- **aucune classe CSS** : les messages sont reliés à leur modèle WhatsApp via `data-id`, le
  type, le sens et le texte viennent des données, pas du rendu ni de la langue de l'interface ;
- **vocaux sans module interne** : l'audio est téléchargé sur le CDN média de WhatsApp puis
  déchiffré (HKDF + AES-CBC, signature vérifiée) avec la clé du message ; le téléchargeur
  interne ne sert que de secours ;
- **fonctions de secours** : l'envoi essaie plusieurs points d'entrée connus, un seul est
  intercepté ;
- **vérifications en direct** : toutes les 5 secondes, la page contrôle l'accès à WhatsApp,
  la lecture des messages, les traductions reçues et envoyées, le bouton de langue et les
  vocaux ;
- **pastille sur l'icône** : orange quand une fonction tourne sur un secours, rouge quand
  elle est cassée ;
- **popup** : état détaillé de chaque fonction, test réel du serveur (santé puis traduction
  de « Bonjour ») et bouton **Copier le diagnostic** à joindre à un signalement.

Pour développer, `WTT_DEV=1 pnpm build` produit un build qui peut être rechargé depuis
l'onglet WhatsApp (`window.postMessage({__wttDev:'reload'}, '*')`). Les builds normaux
(`pnpm build`) n'incluent pas ce raccourci.

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
- `facebook/nllb-200-3.3B` pour la traduction français/anglais/hébreu ;
- le runtime CTranslate2 en FP16 pour exploiter l'A40 avec micro-batching et
  exécutions GPU parallèles.

```bash
cd server-example
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
WTT_API_TOKEN=change-me python serve.py
```

Au premier démarrage, `serve.py` télécharge NLLB-200 3.3B puis le convertit au
format CTranslate2. Le résultat est conservé dans `server-example/models/`. Avec
Docker Compose, les poids Hugging Face et le modèle converti sont conservés dans
deux volumes, donc les redémarrages suivants sont immédiats.

Pour un test local sans jeton, omettre `WTT_API_TOKEN`. Pour un accès réseau, utiliser
HTTPS derrière un proxy et définir obligatoirement un jeton long et aléatoire.

### Docker Compose

Le jeton n'est jamais écrit dans `compose.yaml` : il est lu depuis `server-example/.env`,
fichier ignoré par git.

```bash
cd server-example
echo "WTT_API_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d --build
```

Le port est publié uniquement sur `127.0.0.1:8000`. Pour y accéder depuis un autre
poste, placer le serveur derrière un reverse proxy HTTPS (Caddy, Nginx) ou le joindre
via un VPN (Tailscale, WireGuard), puis saisir cette adresse et le même jeton dans les
réglages de l'extension. L'adresse et le jeton restent dans `chrome.storage.local` et
ne sont jamais transmis au contexte de la page WhatsApp.

Variables utiles :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `WTT_API_TOKEN` | vide | Jeton Bearer requis par l'API |
| `WTT_WHISPER_MODEL` | `large-v3` | Modèle faster-whisper |
| `WTT_TRANSLATION_MODEL` | `facebook/nllb-200-3.3B` | Modèle NLLB source |
| `WTT_TRANSLATION_CT2_MODEL` | `server-example/models/nllb-200-3.3B-ct2` | Modèle converti |
| `WTT_DEVICE` | `cuda` | `cuda` ou `cpu` |
| `WTT_ASR_COMPUTE_TYPE` | `float16` | Précision faster-whisper |
| `WTT_TRANSLATION_COMPUTE_TYPE` | `float16` | Précision CTranslate2 à l'exécution |
| `WTT_TRANSLATION_CONVERSION_TYPE` | `float16` | Quantification lors de la conversion |
| `WTT_ALLOWED_ORIGINS` | `*` | Origines CORS séparées par des virgules |
| `WTT_PRELOAD_MODELS` | `1` | Charge les deux modèles au démarrage |
| `WTT_WARMUP_MODEL` | `1` | Exécute une traduction avant d'accepter le trafic |
| `WTT_ASR_CONCURRENCY` | `1` | Transcriptions simultanées sur le GPU |
| `WTT_ASR_QUEUE_SIZE` | `8` | Vocaux en attente avant réponse HTTP 429 |
| `WTT_ASR_BEAM_SIZE` | `1` | Faisceau Whisper, 1 étant le plus rapide |
| `WTT_TRANSLATION_WORKERS` | `2` | Flux CUDA CTranslate2 partageant les mêmes poids |
| `WTT_TRANSLATION_BATCH_SIZE` | `32` | Requêtes regroupées par micro-batch |
| `WTT_TRANSLATION_BATCH_WAIT_MS` | `8` | Attente maximale pour former un batch |
| `WTT_TRANSLATION_MAX_BATCH_TOKENS` | `4096` | Budget de tokens par batch GPU |
| `WTT_TRANSLATION_QUEUE_SIZE` | `256` | Traductions en attente avant HTTP 429 |
| `WTT_QUEUE_TIMEOUT_SECONDS` | `15` | Temps maximal passé dans une file |
| `WTT_TRANSLATION_BEAMS` | `1` | 1 pour le débit maximal, 2 pour tester plus de qualité |
| `WTT_TRANSLATION_CACHE_SIZE` | `50000` | Traductions conservées en mémoire, 0 pour désactiver |
| `WTT_TRANSLATION_CACHE_TTL_SECONDS` | `86400` | Durée du cache en secondes |

### Concurrence sur une A40

Le serveur charge une seule copie de chaque modèle par processus. CTranslate2 lance
deux workers CUDA qui partagent les poids NLLB. Les requêtes arrivant dans une fenêtre
de 8 ms sont regroupées par paire de langues, puis assemblées dans des batches dont la
taille est calculée en tokens. Ce fonctionnement augmente fortement le débit lorsque
plusieurs utilisateurs reçoivent des messages au même moment.

Les requêtes identiques déjà en cours partagent le même calcul. Les traductions récentes
sont également conservées dans un cache LRU en mémoire : les messages fréquents tels
que « ok », « merci » ou « j'arrive » sont renvoyés sans nouveau passage GPU. Le cache
n'est jamais écrit sur disque et peut être désactivé avec une taille de 0.

L'extension transmet la langue configurée pour le chat comme langue source des messages
reçus. Cela supprime presque tous les appels au détecteur statistique et améliore la
fiabilité sur les très petits messages. Si un texte dépasse la fenêtre NLLB, il est
découpé automatiquement près des fins de phrases au lieu d'être tronqué.

Conserver **un seul worker Uvicorn** : plusieurs processus chargeraient plusieurs copies
des modèles dans la VRAM. Augmenter plutôt `WTT_TRANSLATION_WORKERS` ou le budget de
tokens du batch. Garder Whisper à une seule transcription simultanée au départ afin que
les vocaux longs ne dégradent pas la latence des messages texte. Les files bornées
renvoient HTTP 429 avec `Retry-After` au lieu de saturer la machine.

Les routes `/health` et `/metrics` exposent la profondeur des files, le nombre de batches,
les succès, les rejets, les cache hits et le temps GPU cumulé. Elles sont protégées par
le même Bearer token.

### Mesurer et régler le débit

Après le démarrage du serveur :

```bash
cd server-example
python benchmark.py --token change-me --requests 500 --concurrency 32 --source fr --target he
```

Le script affiche le débit ainsi que les latences moyenne, p50, p95 et p99. Tester les
concurrences 8, 16, 32 et 64. Sur l'A40, régler ensuite `WTT_TRANSLATION_WORKERS` entre
1 et 4 et `WTT_TRANSLATION_MAX_BATCH_TOKENS` entre 2048 et 8192. Le bon réglage est celui
qui maximise les requêtes/seconde sans faire exploser la p95. Les chiffres réels ne
peuvent être établis qu'une fois le conteneur exécuté sur l'A40.

## Limites et sécurité

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

Les poids des modèles ne sont pas inclus dans ce dépôt et restent soumis à leurs propres
licences :

- `facebook/nllb-200-3.3B` : **CC-BY-NC 4.0**, usage non commercial uniquement ;
- Whisper `large-v3` : MIT.

Le serveur optimisé s'appuie sur la prise en charge officielle de NLLB et les mécanismes
de parallélisme documentés par CTranslate2 :

- <https://opennmt.net/CTranslate2/guides/transformers.html#nllb>
- <https://opennmt.net/CTranslate2/parallel.html>
- <https://opennmt.net/CTranslate2/performance.html>
