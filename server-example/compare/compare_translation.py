"""Compare translation engines on real chat phrases before switching models.

Two phases, results merged into compare/results.json and rendered to compare/report.md:

  1. NLLB baseline, through the running translation server (plain Python, no dependency):
       WTT_API_TOKEN=… python3 compare/compare_translation.py nllb --url https://…

  2. LLM candidates, offline with vLLM. Stop the translation server first to free the GPU,
     then run inside the vLLM image (see compare/README.md):
       python3 compare/compare_translation.py llm --models cyankiwi/gemma-4-26B-A4B-it-qat-AWQ-INT4 …

Each LLM runs in its own subprocess so its VRAM is fully released before the next one.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SAMPLES = HERE / "samples.json"
RESULTS = HERE / "results.json"
REPORT = HERE / "report.md"

DEFAULT_MODELS = [
    # MoE models only: ~3-4B active parameters per token, so latency stays low. All int4 AWQ.
    # Gemma 4 QAT (trained by Google for 4-bit): should lose the least quality.
    "cyankiwi/gemma-4-26B-A4B-it-qat-AWQ-INT4",
    # Standard Gemma 4, same quantizer: far more widely used with vLLM.
    "cyankiwi/gemma-4-26B-A4B-it-AWQ-4bit",
    # Other MoE family, as a point of comparison.
    "QuantTrio/Qwen3.6-35B-A3B-AWQ",
]

LANGUAGE_NAMES = {"fr": "French", "en": "English", "he": "Hebrew", "es": "Spanish", "de": "German", "ar": "Arabic"}

# The prompt the extension would use in production. Kept here so the comparison measures
# exactly what users would get.
SYSTEM_PROMPT = """You translate WhatsApp chat messages from {source} to {target}.
Translate the meaning, not the words:
- Render idioms, slang and expressions with a natural equivalent a native {target} speaker would use, never word for word.
- Keep the tone and register of the original (casual stays casual, playful stays playful, professional stays professional).
- Silently fix obvious typos in the original before translating.
- Preserve emojis, line breaks, names, @-mentions, links and numbers.
- Do not add, remove or explain anything.
Output only the translation."""


def load_samples() -> list[dict]:
    return json.loads(SAMPLES.read_text(encoding="utf-8"))["samples"]


def load_results() -> dict:
    return json.loads(RESULTS.read_text(encoding="utf-8")) if RESULTS.exists() else {"engines": {}}


def save_engine(name: str, rows: list[dict], meta: dict) -> None:
    results = load_results()
    results["engines"][name] = {"meta": meta, "rows": rows}
    RESULTS.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    render_report(results)


def render_report(results: dict) -> None:
    samples = load_samples()
    engines = results["engines"]
    lines = ["# Comparaison des traductions", ""]
    lines.append("| Moteur | Latence moyenne / phrase | Détail |")
    lines.append("| --- | --- | --- |")
    for name, data in engines.items():
        meta = data["meta"]
        lines.append(f"| `{name}` | {meta.get('avg_ms', '?')} ms | {meta.get('note', '')} |")
    lines.append("")
    for i, sample in enumerate(samples):
        lines.append(f"## {i + 1}. {sample['source']} → {sample['target']}")
        lines.append("")
        lines.append(f"> {sample['text']}")
        lines.append("")
        for name, data in engines.items():
            rows = data["rows"]
            translation = rows[i]["translation"] if i < len(rows) else "—"
            lines.append(f"- **{name}** : {translation}")
        lines.append("")
    REPORT.write_text("\n".join(lines), encoding="utf-8")


def run_nllb(url: str, token: str) -> None:
    rows, total = [], 0.0
    for sample in load_samples():
        body = json.dumps({"text": sample["text"], "source": sample["source"], "target": sample["target"]}).encode()
        request = urllib.request.Request(
            url.rstrip("/") + "/v1/translate",
            data=body,
            headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
        )
        started = time.perf_counter()
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.load(response)
        elapsed = (time.perf_counter() - started) * 1000
        total += elapsed
        rows.append({"translation": data.get("translated_text", ""), "ms": round(elapsed)})
        print(f"[nllb] {sample['text'][:40]!r} → {rows[-1]['translation'][:60]!r}")
    save_engine("NLLB-200 3.3B (actuel)", rows, {"avg_ms": round(total / len(rows)), "note": "via le serveur, requêtes une par une"})


def clean(text: str) -> str:
    # Some models still emit a reasoning block even with thinking disabled.
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()


def run_one_llm(model: str, gpu_memory_utilization: float, max_model_len: int) -> None:
    from vllm import LLM, SamplingParams  # imported here: phase 1 needs no dependency

    samples = load_samples()
    conversations = [
        [
            {"role": "system", "content": SYSTEM_PROMPT.format(
                source=LANGUAGE_NAMES.get(s["source"], s["source"]),
                target=LANGUAGE_NAMES.get(s["target"], s["target"]),
            )},
            {"role": "user", "content": s["text"]},
        ]
        for s in samples
    ]
    llm = LLM(model=model, gpu_memory_utilization=gpu_memory_utilization, max_model_len=max_model_len)
    params = SamplingParams(temperature=0.1, max_tokens=512)
    template = {"enable_thinking": False}

    # One request alone first: the latency a single outgoing message would see.
    llm.chat([conversations[0]], params, chat_template_kwargs=template, use_tqdm=False)  # warm-up
    started = time.perf_counter()
    llm.chat([conversations[0]], params, chat_template_kwargs=template, use_tqdm=False)
    single_ms = round((time.perf_counter() - started) * 1000)

    # Then the whole set at once: how a burst of incoming history is handled.
    started = time.perf_counter()
    outputs = llm.chat(conversations, params, chat_template_kwargs=template, use_tqdm=False)
    batch_ms = (time.perf_counter() - started) * 1000

    rows = [{"translation": clean(o.outputs[0].text)} for o in outputs]
    for sample, row in zip(samples, rows):
        print(f"[{model}] {sample['text'][:40]!r} → {row['translation'][:60]!r}")
    save_engine(model, rows, {
        "avg_ms": single_ms,
        "note": f"message seul : {single_ms} ms · {len(rows)} messages en parallèle : {round(batch_ms)} ms au total",
    })


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="phase", required=True)

    nllb = sub.add_parser("nllb", help="baseline through the running translation server")
    nllb.add_argument("--url", required=True)
    # From the environment, not the command line, so the token stays out of shell history.
    nllb.add_argument("--token", default=os.environ.get("WTT_API_TOKEN", ""))

    llm = sub.add_parser("llm", help="LLM candidates with vLLM (translation server stopped)")
    llm.add_argument("--models", nargs="+", default=DEFAULT_MODELS)
    llm.add_argument("--gpu-memory-utilization", type=float, default=0.9)
    llm.add_argument("--max-model-len", type=int, default=4096)
    llm.add_argument("--single", help=argparse.SUPPRESS)

    args = parser.parse_args()
    if args.phase == "nllb":
        if not args.token:
            parser.error("WTT_API_TOKEN n'est pas défini")
        run_nllb(args.url, args.token)
    elif args.single:
        run_one_llm(args.single, args.gpu_memory_utilization, args.max_model_len)
    else:
        for model in args.models:
            print(f"\n=== {model} ===", flush=True)
            code = subprocess.call([
                sys.executable, __file__, "llm", "--single", model,
                "--gpu-memory-utilization", str(args.gpu_memory_utilization),
                "--max-model-len", str(args.max_model_len),
            ])
            if code != 0:
                print(f"!! {model} a échoué (code {code}), on passe au suivant", flush=True)
    print(f"\nRapport : {REPORT}")


if __name__ == "__main__":
    main()
