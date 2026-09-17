# Comparer les modèles de traduction

Traduit les phrases de `samples.json` avec NLLB (le modèle actuel) puis avec plusieurs LLM,
et écrit un rapport côte à côte dans `report.md`. Rien n'est modifié sur le serveur en
production. Ajoutez vos propres expressions dans `samples.json` avant de lancer.

Candidats par défaut : uniquement des MoE en int4 AWQ (3 à 4 milliards de paramètres actifs par
mot, donc rapides), tous sous licence Apache 2.0 :

| Modèle | Point de départ | Poids | Rôle |
| --- | --- | --- | --- |
| `cyankiwi/gemma-4-26B-A4B-it-qat-AWQ-INT4` | Gemma 4 QAT (entraîné par Google pour le 4 bits) | ~17 Go | Devrait perdre le moins de qualité |
| `cyankiwi/gemma-4-26B-A4B-it-AWQ-4bit` | Gemma 4 standard | ~17 Go | Le plus utilisé avec vLLM |
| `QuantTrio/Qwen3.6-35B-A3B-AWQ` | Qwen 3.6 | ~25 Go | Autre famille, pour comparaison |

Les quantifications sont communautaires ; les poids d'origine viennent de Google et Qwen. Les
deux Gemma ont été calibrés sans hébreu : c'est la langue à regarder de près dans le rapport.
Prévoir environ **60 Go d'espace disque** et une vingtaine de minutes.

## 1. Référence NLLB (serveur démarré)

Depuis `server-example/`, le jeton est lu dans `.env` pour ne pas apparaître dans l'historique :

```bash
set -a; . ./.env; set +a
python3 compare/compare_translation.py nllb --url http://127.0.0.1:8000
```

## 2. LLM candidats (serveur arrêté)

Les LLM ont besoin de toute la mémoire de l'A40 : arrêtez d'abord le serveur de traduction.

```bash
docker compose stop
docker run --rm --gpus all --ipc=host \
  -v "$PWD/compare:/work/compare" \
  -v wtt-compare-hf:/root/.cache/huggingface \
  --entrypoint python3 vllm/vllm-openai:latest \
  /work/compare/compare_translation.py llm
docker compose start
```

Pour tester d'autres modèles : ajoutez `--models modèle1 modèle2` à la fin de la commande.
Si un modèle ne tient pas en mémoire, il est ignoré et le script passe au suivant.

## 3. Lire le résultat

`compare/report.md` liste, pour chaque phrase, la traduction de chaque moteur, ainsi que la
latence d'un message seul et celle d'une rafale de messages. Les résultats bruts sont dans
`compare/results.json`.

Pour libérer le disque ensuite : `docker volume rm wtt-compare-hf`.
