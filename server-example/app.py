from __future__ import annotations

import asyncio
import hmac
import logging
import os
import queue
import re
import tempfile
import threading
import time
from collections import OrderedDict, defaultdict
from concurrent.futures import Future
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import ctranslate2
import torch
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from faster_whisper import WhisperModel
from langdetect import DetectorFactory, LangDetectException, detect
from pydantic import BaseModel
from transformers import AutoTokenizer


logging.basicConfig(level=os.getenv("WTT_LOG_LEVEL", "INFO"))
logger = logging.getLogger("wtt-server")
DetectorFactory.seed = 0
STARTED_AT = time.monotonic()


def env_int(name: str, default: int, minimum: int = 1) -> int:
    return max(minimum, int(os.getenv(name, str(default))))


def env_bool(name: str, default: bool) -> bool:
    return os.getenv(name, "1" if default else "0").strip().lower() in {
        "1", "true", "yes", "on"
    }


API_TOKEN = os.getenv("WTT_API_TOKEN", "").strip()
WHISPER_MODEL = os.getenv("WTT_WHISPER_MODEL", "large-v3")
TRANSLATION_MODEL = os.getenv("WTT_TRANSLATION_MODEL", "facebook/nllb-200-3.3B")
TRANSLATION_CT2_MODEL = os.getenv(
    "WTT_TRANSLATION_CT2_MODEL",
    str(Path(__file__).parent / "models" / "nllb-200-3.3B-ct2"),
)
DEVICE = os.getenv("WTT_DEVICE", "cuda")
ASR_COMPUTE_TYPE = os.getenv("WTT_ASR_COMPUTE_TYPE", "float16")
TRANSLATION_COMPUTE_TYPE = os.getenv("WTT_TRANSLATION_COMPUTE_TYPE", "float16")
PRELOAD_MODELS = env_bool("WTT_PRELOAD_MODELS", True)
WARMUP_MODEL = env_bool("WTT_WARMUP_MODEL", True)

# Text is latency-sensitive. Audio has a separate, smaller queue so a burst of
# long voice notes cannot consume every request slot.
ASR_CONCURRENCY = env_int("WTT_ASR_CONCURRENCY", 1)
ASR_QUEUE_SIZE = env_int("WTT_ASR_QUEUE_SIZE", 8)
ASR_BEAM_SIZE = env_int("WTT_ASR_BEAM_SIZE", 1)
MAX_AUDIO_BYTES = env_int("WTT_MAX_AUDIO_BYTES", 50 * 1024 * 1024)

TRANSLATION_WORKERS = env_int("WTT_TRANSLATION_WORKERS", 2)
TRANSLATION_QUEUE_SIZE = env_int("WTT_TRANSLATION_QUEUE_SIZE", 256)
TRANSLATION_BATCH_SIZE = env_int("WTT_TRANSLATION_BATCH_SIZE", 32)
TRANSLATION_BATCH_WAIT_MS = env_int("WTT_TRANSLATION_BATCH_WAIT_MS", 8)
TRANSLATION_MAX_BATCH_TOKENS = env_int("WTT_TRANSLATION_MAX_BATCH_TOKENS", 4096)
TRANSLATION_MAX_INPUT_TOKENS = env_int("WTT_TRANSLATION_MAX_INPUT_TOKENS", 512)
TRANSLATION_CHUNK_TOKENS = max(
    1,
    min(
        env_int("WTT_TRANSLATION_CHUNK_TOKENS", 480),
        TRANSLATION_MAX_INPUT_TOKENS - 8,
    ),
)
TRANSLATION_MAX_OUTPUT_TOKENS = env_int("WTT_TRANSLATION_MAX_OUTPUT_TOKENS", 512)
TRANSLATION_BEAMS = env_int("WTT_TRANSLATION_BEAMS", 1)
TRANSLATION_FLASH_ATTENTION = env_bool("WTT_TRANSLATION_FLASH_ATTENTION", True)
QUEUE_TIMEOUT_SECONDS = env_int("WTT_QUEUE_TIMEOUT_SECONDS", 15)
MAX_TEXT_CHARS = env_int("WTT_MAX_TEXT_CHARS", 20_000)

CACHE_SIZE = env_int("WTT_TRANSLATION_CACHE_SIZE", 50_000, minimum=0)
CACHE_TTL_SECONDS = env_int("WTT_TRANSLATION_CACHE_TTL_SECONDS", 86_400)

ALLOWED_ORIGINS = [
    value.strip()
    for value in os.getenv("WTT_ALLOWED_ORIGINS", "*").split(",")
    if value.strip()
]

LANGUAGES = {
    "en": "eng_Latn", "fr": "fra_Latn", "es": "spa_Latn", "de": "deu_Latn",
    "it": "ita_Latn", "pt": "por_Latn", "nl": "nld_Latn", "pl": "pol_Latn",
    "ru": "rus_Cyrl", "uk": "ukr_Cyrl", "tr": "tur_Latn", "ar": "arb_Arab",
    "he": "heb_Hebr", "fa": "pes_Arab", "ur": "urd_Arab", "hi": "hin_Deva",
    "bn": "ben_Beng", "ta": "tam_Taml", "te": "tel_Telu", "ml": "mal_Mlym",
    "th": "tha_Thai", "vi": "vie_Latn", "id": "ind_Latn", "ms": "zsm_Latn",
    "tl": "tgl_Latn", "ja": "jpn_Jpan", "ko": "kor_Hang", "zh-cn": "zho_Hans",
    "zh-tw": "zho_Hant", "zh": "zho_Hans", "sv": "swe_Latn", "no": "nob_Latn",
    "da": "dan_Latn", "fi": "fin_Latn", "cs": "ces_Latn", "el": "ell_Grek",
    "ro": "ron_Latn", "hu": "hun_Latn", "sw": "swh_Latn",
}


class Metrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._values: defaultdict[str, float] = defaultdict(float)

    def inc(self, name: str, amount: float = 1) -> None:
        with self._lock:
            self._values[name] += amount

    def snapshot(self) -> dict[str, float]:
        with self._lock:
            return dict(self._values)


class TTLCache:
    def __init__(self, max_size: int, ttl_seconds: int) -> None:
        self.max_size = max_size
        self.ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._items: OrderedDict[tuple[str, str, str], tuple[float, str]] = OrderedDict()

    def get(self, key: tuple[str, str, str]) -> str | None:
        now = time.monotonic()
        with self._lock:
            item = self._items.get(key)
            if item is None:
                return None
            created_at, value = item
            if now - created_at > self.ttl_seconds:
                del self._items[key]
                return None
            self._items.move_to_end(key)
            return value

    def put(self, key: tuple[str, str, str], value: str) -> None:
        if self.max_size == 0:
            return
        with self._lock:
            self._items[key] = (time.monotonic(), value)
            self._items.move_to_end(key)
            while len(self._items) > self.max_size:
                self._items.popitem(last=False)

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)


metrics = Metrics()
translation_cache = TTLCache(CACHE_SIZE, CACHE_TTL_SECONDS)

_whisper: WhisperModel | None = None
_translator: ctranslate2.Translator | None = None
_tokenizers: dict[str, object] = {}
_translation_batcher: TranslationBatcher | None = None
_whisper_load_lock = threading.Lock()
_translator_load_lock = threading.Lock()
_tokenizer_load_lock = threading.Lock()
_batcher_load_lock = threading.Lock()
_asr_slots = threading.BoundedSemaphore(ASR_CONCURRENCY)
_asr_capacity = threading.BoundedSemaphore(ASR_CONCURRENCY + ASR_QUEUE_SIZE)


def require_token(authorization: str | None = Header(default=None)) -> None:
    if not API_TOKEN:
        return
    expected = f"Bearer {API_TOKEN}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Invalid bearer token")


def get_whisper() -> WhisperModel:
    global _whisper
    if _whisper is None:
        with _whisper_load_lock:
            if _whisper is None:
                logger.info("Loading Whisper model %s", WHISPER_MODEL)
                _whisper = WhisperModel(
                    WHISPER_MODEL,
                    device=DEVICE,
                    compute_type=ASR_COMPUTE_TYPE,
                    num_workers=ASR_CONCURRENCY,
                )
    return _whisper


def get_translator() -> ctranslate2.Translator:
    global _translator
    if _translator is None:
        with _translator_load_lock:
            if _translator is None:
                model_path = Path(TRANSLATION_CT2_MODEL)
                if not (model_path / "model.bin").exists():
                    raise RuntimeError(
                        f"CTranslate2 model missing at {model_path}. Run prepare_model.py first."
                    )
                logger.info(
                    "Loading CTranslate2 model %s with %s workers",
                    model_path,
                    TRANSLATION_WORKERS,
                )
                kwargs = dict(
                    model_path=str(model_path),
                    device=DEVICE,
                    compute_type=TRANSLATION_COMPUTE_TYPE,
                    inter_threads=TRANSLATION_WORKERS,
                    max_queued_batches=TRANSLATION_WORKERS * 4,
                )
                try:
                    _translator = ctranslate2.Translator(
                        **kwargs,
                        flash_attention=TRANSLATION_FLASH_ATTENTION,
                    )
                except (RuntimeError, ValueError):
                    if not TRANSLATION_FLASH_ATTENTION:
                        raise
                    logger.warning("Flash Attention unavailable; falling back to standard attention")
                    _translator = ctranslate2.Translator(**kwargs, flash_attention=False)
    return _translator


def get_tokenizer(source: str):
    tokenizer = _tokenizers.get(source)
    if tokenizer is None:
        with _tokenizer_load_lock:
            tokenizer = _tokenizers.get(source)
            if tokenizer is None:
                tokenizer = AutoTokenizer.from_pretrained(
                    TRANSLATION_MODEL,
                    src_lang=LANGUAGES[source],
                    use_fast=True,
                )
                _tokenizers[source] = tokenizer
    return tokenizer


def normalize_language(code: str) -> str:
    normalized = code.strip().lower().replace("_", "-")
    if normalized in LANGUAGES:
        return normalized
    short = normalized.split("-")[0]
    if short in LANGUAGES:
        return short
    raise HTTPException(status_code=400, detail=f"Unsupported language: {code}")


def detect_language(text: str) -> str:
    # Script detection is faster and more reliable than statistical detection for
    # one- or two-word Hebrew chat messages.
    if re.search(r"[\u0590-\u05ff]", text):
        return "he"
    try:
        return detect(text)
    except LangDetectException as error:
        raise HTTPException(
            status_code=400,
            detail="Unable to detect source language; send an explicit source code",
        ) from error


def split_text(text: str, tokenizer) -> list[str]:
    """Split long text without silently truncating it at NLLB's training limit."""
    if len(tokenizer.encode(text)) <= TRANSLATION_MAX_INPUT_TOKENS:
        return [text]

    pieces = [part for part in re.split(r"(?<=[.!?…])\s+|\n+", text) if part]
    chunks: list[str] = []
    current: list[str] = []
    current_tokens = 0

    for piece in pieces:
        ids = tokenizer.encode(piece, add_special_tokens=False)
        if len(ids) > TRANSLATION_CHUNK_TOKENS:
            if current:
                chunks.append(" ".join(current))
                current, current_tokens = [], 0
            for start in range(0, len(ids), TRANSLATION_CHUNK_TOKENS):
                token_slice = ids[start : start + TRANSLATION_CHUNK_TOKENS]
                chunks.append(tokenizer.decode(token_slice, skip_special_tokens=True))
            continue

        if current and current_tokens + len(ids) > TRANSLATION_CHUNK_TOKENS:
            chunks.append(" ".join(current))
            current, current_tokens = [], 0
        current.append(piece)
        current_tokens += len(ids)

    if current:
        chunks.append(" ".join(current))
    return chunks or [text]


@dataclass
class TranslationJob:
    key: tuple[str, str, str]
    text: str
    source: str
    target: str
    future: Future[str]
    queued_at: float


class TranslationBatcher:
    """Fair, bounded micro-batching in front of shared CTranslate2 GPU workers."""

    def __init__(self) -> None:
        self.jobs: queue.Queue[TranslationJob] = queue.Queue(TRANSLATION_QUEUE_SIZE)
        self.stopping = threading.Event()
        self.inflight: dict[tuple[str, str, str], Future[str]] = {}
        self.inflight_lock = threading.Lock()
        self.workers = [
            threading.Thread(
                target=self._run,
                name=f"nllb-batcher-{index}",
                daemon=True,
            )
            for index in range(TRANSLATION_WORKERS)
        ]
        for worker in self.workers:
            worker.start()

    async def submit(self, text: str, source: str, target: str) -> str:
        key = (source, target, text)
        cached = translation_cache.get(key)
        if cached is not None:
            metrics.inc("translation_cache_hits_total")
            return cached

        with self.inflight_lock:
            future = self.inflight.get(key)
            if future is None:
                future = Future()
                self.inflight[key] = future
                owner = True
            else:
                owner = False

        if owner:
            try:
                self.jobs.put_nowait(
                    TranslationJob(key, text, source, target, future, time.monotonic())
                )
            except queue.Full as error:
                with self.inflight_lock:
                    self.inflight.pop(key, None)
                metrics.inc("translation_queue_rejected_total")
                raise HTTPException(
                    status_code=429,
                    detail="Translation queue is full; retry shortly",
                    headers={"Retry-After": "1"},
                ) from error
        else:
            metrics.inc("translation_deduplicated_total")

        try:
            return await asyncio.wait_for(
                asyncio.shield(asyncio.wrap_future(future)),
                timeout=QUEUE_TIMEOUT_SECONDS,
            )
        except TimeoutError as error:
            metrics.inc("translation_timeouts_total")
            raise HTTPException(status_code=504, detail="Translation queue timeout") from error

    def close(self) -> None:
        self.stopping.set()
        for worker in self.workers:
            worker.join(timeout=2)

    def _complete(self, job: TranslationJob, result: str | None, error: Exception | None) -> None:
        if error is None and result is not None:
            translation_cache.put(job.key, result)
            if not job.future.done():
                job.future.set_result(result)
        elif not job.future.done():
            job.future.set_exception(error or RuntimeError("Unknown translation error"))
        with self.inflight_lock:
            self.inflight.pop(job.key, None)

    def _run(self) -> None:
        while not self.stopping.is_set():
            try:
                first = self.jobs.get(timeout=0.1)
            except queue.Empty:
                continue

            batch = [first]
            deadline = time.monotonic() + TRANSLATION_BATCH_WAIT_MS / 1000
            while len(batch) < TRANSLATION_BATCH_SIZE:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    batch.append(self.jobs.get(timeout=remaining))
                except queue.Empty:
                    break

            groups: dict[tuple[str, str], list[TranslationJob]] = defaultdict(list)
            for job in batch:
                groups[(job.source, job.target)].append(job)

            metrics.inc("translation_batches_total", len(groups))
            metrics.inc("translation_batch_messages_total", len(batch))
            metrics.inc(
                "translation_queue_wait_seconds_total",
                sum(time.monotonic() - job.queued_at for job in batch),
            )
            for (source, target), group in groups.items():
                started = time.monotonic()
                try:
                    translations = self._translate_group(
                        [job.text for job in group], source, target
                    )
                    for job, translated in zip(group, translations, strict=True):
                        self._complete(job, translated, None)
                    metrics.inc("translation_completed_total", len(group))
                except Exception as error:
                    logger.exception("Translation batch failed")
                    metrics.inc("translation_failed_total", len(group))
                    for job in group:
                        self._complete(job, None, error)
                finally:
                    metrics.inc(
                        "translation_gpu_seconds_total",
                        time.monotonic() - started,
                    )

            for _ in batch:
                self.jobs.task_done()

    @staticmethod
    def _translate_group(texts: list[str], source: str, target: str) -> list[str]:
        tokenizer = get_tokenizer(source)
        encoded_chunks: list[list[str]] = []
        owners: list[int] = []
        for owner, text in enumerate(texts):
            for chunk in split_text(text, tokenizer):
                ids = tokenizer.encode(chunk)
                encoded_chunks.append(tokenizer.convert_ids_to_tokens(ids))
                owners.append(owner)

        target_prefix = [[LANGUAGES[target]] for _ in encoded_chunks]
        results = get_translator().translate_batch(
            encoded_chunks,
            target_prefix=target_prefix,
            max_batch_size=TRANSLATION_MAX_BATCH_TOKENS,
            batch_type="tokens",
            beam_size=TRANSLATION_BEAMS,
            max_input_length=TRANSLATION_MAX_INPUT_TOKENS,
            max_decoding_length=TRANSLATION_MAX_OUTPUT_TOKENS,
            return_scores=False,
        )

        translated_chunks: list[list[str]] = [[] for _ in texts]
        for owner, result in zip(owners, results, strict=True):
            tokens = result.hypotheses[0]
            if tokens and tokens[0] == LANGUAGES[target]:
                tokens = tokens[1:]
            token_ids = tokenizer.convert_tokens_to_ids(tokens)
            translated_chunks[owner].append(
                tokenizer.decode(token_ids, skip_special_tokens=True).strip()
            )
        return [" ".join(part for part in parts if part).strip() for parts in translated_chunks]


def get_translation_batcher() -> TranslationBatcher:
    global _translation_batcher
    if _translation_batcher is None:
        with _batcher_load_lock:
            if _translation_batcher is None:
                _translation_batcher = TranslationBatcher()
    return _translation_batcher


@asynccontextmanager
async def lifespan(_: FastAPI):
    if PRELOAD_MODELS:
        await asyncio.to_thread(get_translator)
        for language in ("fr", "en", "he"):
            await asyncio.to_thread(get_tokenizer, language)
        batcher = get_translation_batcher()
        if WARMUP_MODEL:
            await asyncio.to_thread(
                batcher._translate_group,
                ["The server is ready."],
                "en",
                "fr",
            )
        await asyncio.to_thread(get_whisper)
    yield
    if _translation_batcher is not None:
        _translation_batcher.close()


app = FastAPI(
    title="WhatsApp Web Translator A40 API",
    version="0.4.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["authorization", "content-type"],
)


class TranslationRequest(BaseModel):
    text: str
    source: str = "auto"
    target: str
    model: str | None = None
    style: str | None = None


@app.get("/health", dependencies=[Depends(require_token)])
def health():
    translator = _translator
    return {
        "status": "ok",
        "uptime_seconds": round(time.monotonic() - STARTED_AT, 1),
        "device": DEVICE,
        "cuda": torch.cuda.is_available(),
        "models_loaded": {
            "whisper": _whisper is not None,
            "translation": translator is not None,
        },
        "whisper_model": WHISPER_MODEL,
        "translation_model": TRANSLATION_MODEL,
        "translation_runtime": "ctranslate2",
        "translation_compute_type": (
            translator.compute_type if translator is not None else TRANSLATION_COMPUTE_TYPE
        ),
        "translation_workers": TRANSLATION_WORKERS,
        "translation_active_batches": translator.num_active_batches if translator else 0,
        "translation_runtime_queue": translator.num_queued_batches if translator else 0,
        "translation_queue_depth": _translation_batcher.jobs.qsize() if _translation_batcher else 0,
        "translation_cache_entries": len(translation_cache),
        "asr_concurrency": ASR_CONCURRENCY,
        "asr_queue_size": ASR_QUEUE_SIZE,
        "metrics": metrics.snapshot(),
    }


@app.get("/metrics", dependencies=[Depends(require_token)], response_class=PlainTextResponse)
def prometheus_metrics() -> str:
    values = metrics.snapshot()
    values["translation_queue_depth"] = (
        _translation_batcher.jobs.qsize() if _translation_batcher else 0
    )
    values["translation_cache_entries"] = len(translation_cache)
    values["process_uptime_seconds"] = time.monotonic() - STARTED_AT
    return "\n".join(f"wtt_{name} {value}" for name, value in sorted(values.items())) + "\n"


@app.post("/v1/translate", dependencies=[Depends(require_token)])
async def translate_text(request: TranslationRequest):
    metrics.inc("translation_requests_total")
    text = request.text.strip()
    if not text:
        return {"translated_text": "", "detected_language": "unknown"}
    if len(request.text) > MAX_TEXT_CHARS:
        raise HTTPException(status_code=413, detail="Text is too large")

    detected = detect_language(text) if request.source == "auto" else request.source
    source = normalize_language(detected)
    target = normalize_language(request.target)
    if source == target:
        metrics.inc("translation_bypassed_total")
        return {"translated_text": request.text, "detected_language": source}

    started = time.monotonic()
    translated = await get_translation_batcher().submit(request.text, source, target)
    return {
        "translated_text": translated,
        "detected_language": source,
        "latency_ms": round((time.monotonic() - started) * 1000, 1),
    }


def transcribe_file(path: str, language: str | None) -> tuple[str, object]:
    if not _asr_slots.acquire(timeout=QUEUE_TIMEOUT_SECONDS):
        raise HTTPException(status_code=504, detail="Transcription queue timeout")
    started = time.monotonic()
    try:
        segments, info = get_whisper().transcribe(
            path,
            language=None if not language or language == "auto" else language,
            vad_filter=True,
            beam_size=ASR_BEAM_SIZE,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        metrics.inc("asr_completed_total")
        metrics.inc("asr_gpu_seconds_total", time.monotonic() - started)
        return text, info
    finally:
        _asr_slots.release()


@app.post("/v1/audio/transcriptions", dependencies=[Depends(require_token)])
async def transcribe_audio(
    file: UploadFile = File(...),
    model: str = Form(default="large-v3"),
    language: str | None = Form(default=None),
    response_format: str = Form(default="json"),
    diarize: bool = Form(default=False),
):
    del model, response_format, diarize
    metrics.inc("asr_requests_total")
    if not _asr_capacity.acquire(blocking=False):
        metrics.inc("asr_queue_rejected_total")
        raise HTTPException(
            status_code=429,
            detail="Transcription queue is full; retry shortly",
            headers={"Retry-After": "2"},
        )

    temporary_path: str | None = None
    try:
        suffix = Path(file.filename or "voice.ogg").suffix or ".ogg"
        total = 0
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temporary:
            temporary_path = temporary.name
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_AUDIO_BYTES:
                    raise HTTPException(status_code=413, detail="Audio file is too large")
                temporary.write(chunk)

        text, info = await asyncio.to_thread(transcribe_file, temporary_path, language)
    finally:
        _asr_capacity.release()
        await file.close()
        if temporary_path:
            Path(temporary_path).unlink(missing_ok=True)

    return {
        "text": text,
        "language": info.language or "unknown",
        "confidence": info.language_probability,
    }
