from __future__ import annotations

import asyncio
import hmac
import os
import queue
import tempfile
import threading
import time
from collections import defaultdict
from concurrent.futures import Future, TimeoutError as FutureTimeout
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import torch
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
from langdetect import DetectorFactory, detect
from pydantic import BaseModel
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer


DetectorFactory.seed = 0


def env_int(name: str, default: int, minimum: int = 1) -> int:
    return max(minimum, int(os.getenv(name, str(default))))


API_TOKEN = os.getenv("WTT_API_TOKEN", "").strip()
WHISPER_MODEL = os.getenv("WTT_WHISPER_MODEL", "large-v3")
TRANSLATION_MODEL = os.getenv(
    "WTT_TRANSLATION_MODEL", "facebook/nllb-200-distilled-600M"
)
DEVICE = os.getenv("WTT_DEVICE", "cuda")
COMPUTE_TYPE = os.getenv("WTT_COMPUTE_TYPE", "float16")
PRELOAD_MODELS = os.getenv("WTT_PRELOAD_MODELS", "1") == "1"

# One model instance per process. CTranslate2 shares weights between its workers.
ASR_CONCURRENCY = env_int("WTT_ASR_CONCURRENCY", 2)
ASR_QUEUE_SIZE = env_int("WTT_ASR_QUEUE_SIZE", 16)
TRANSLATION_QUEUE_SIZE = env_int("WTT_TRANSLATION_QUEUE_SIZE", 128)
TRANSLATION_BATCH_SIZE = env_int("WTT_TRANSLATION_BATCH_SIZE", 16)
TRANSLATION_BATCH_WAIT_MS = env_int("WTT_TRANSLATION_BATCH_WAIT_MS", 20)
QUEUE_TIMEOUT_SECONDS = env_int("WTT_QUEUE_TIMEOUT_SECONDS", 180)
TRANSLATION_BEAMS = env_int("WTT_TRANSLATION_BEAMS", 2)

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

_whisper: WhisperModel | None = None
_tokenizer = None
_translator = None
_translation_batcher: TranslationBatcher | None = None
_whisper_load_lock = threading.Lock()
_translator_load_lock = threading.Lock()
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
                _whisper = WhisperModel(
                    WHISPER_MODEL,
                    device=DEVICE,
                    compute_type=COMPUTE_TYPE,
                    num_workers=ASR_CONCURRENCY,
                )
    return _whisper


def get_translator():
    global _tokenizer, _translator
    if _translator is None:
        with _translator_load_lock:
            if _translator is None:
                tokenizer = AutoTokenizer.from_pretrained(TRANSLATION_MODEL)
                dtype = torch.float16 if DEVICE == "cuda" else torch.float32
                translator = AutoModelForSeq2SeqLM.from_pretrained(
                    TRANSLATION_MODEL, torch_dtype=dtype
                ).to(DEVICE)
                translator.eval()
                _tokenizer = tokenizer
                _translator = translator
    return _tokenizer, _translator


def normalize_language(code: str) -> str:
    normalized = code.strip().lower().replace("_", "-")
    if normalized in LANGUAGES:
        return normalized
    short = normalized.split("-")[0]
    if short in LANGUAGES:
        return short
    raise HTTPException(status_code=400, detail=f"Unsupported language: {code}")


@dataclass
class TranslationJob:
    text: str
    source: str
    target: str
    future: Future[str]


class TranslationBatcher:
    """Micro-batches concurrent messages sharing the same language pair."""

    def __init__(self) -> None:
        self.jobs: queue.Queue[TranslationJob] = queue.Queue(TRANSLATION_QUEUE_SIZE)
        self.stopping = threading.Event()
        self.worker = threading.Thread(target=self._run, name="nllb-batcher", daemon=True)
        self.worker.start()

    def submit(self, text: str, source: str, target: str) -> str:
        future: Future[str] = Future()
        try:
            self.jobs.put_nowait(TranslationJob(text, source, target, future))
        except queue.Full as error:
            raise HTTPException(status_code=429, detail="Translation queue is full") from error
        try:
            return future.result(timeout=QUEUE_TIMEOUT_SECONDS)
        except FutureTimeout as error:
            future.cancel()
            raise HTTPException(status_code=504, detail="Translation queue timeout") from error

    def close(self) -> None:
        self.stopping.set()
        self.worker.join(timeout=2)

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

            for (source, target), group in groups.items():
                try:
                    translations = self._translate_group(
                        [job.text for job in group], source, target
                    )
                    for job, translated in zip(group, translations, strict=True):
                        if not job.future.done():
                            job.future.set_result(translated)
                except Exception as error:
                    for job in group:
                        if not job.future.done():
                            job.future.set_exception(error)
                finally:
                    for _ in group:
                        self.jobs.task_done()

    @staticmethod
    def _translate_group(texts: list[str], source: str, target: str) -> list[str]:
        tokenizer, model = get_translator()
        tokenizer.src_lang = LANGUAGES[source]
        inputs = tokenizer(
            texts,
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=1024,
        ).to(DEVICE)
        target_token = tokenizer.convert_tokens_to_ids(LANGUAGES[target])
        with torch.inference_mode():
            output = model.generate(
                **inputs,
                forced_bos_token_id=target_token,
                max_new_tokens=768,
                num_beams=TRANSLATION_BEAMS,
            )
        return tokenizer.batch_decode(output, skip_special_tokens=True)


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
        await asyncio.to_thread(get_whisper)
        await asyncio.to_thread(get_translator)
        get_translation_batcher()
    yield
    if _translation_batcher is not None:
        _translation_batcher.close()


app = FastAPI(
    title="WhatsApp Web Translator A40 API",
    version="0.3.0",
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
    return {
        "status": "ok",
        "device": DEVICE,
        "cuda": torch.cuda.is_available(),
        "models_loaded": {"whisper": _whisper is not None, "translation": _translator is not None},
        "whisper_model": WHISPER_MODEL,
        "translation_model": TRANSLATION_MODEL,
        "asr_concurrency": ASR_CONCURRENCY,
        "asr_queue_size": ASR_QUEUE_SIZE,
        "translation_batch_size": TRANSLATION_BATCH_SIZE,
        "translation_queue_depth": _translation_batcher.jobs.qsize() if _translation_batcher else 0,
    }


@app.post("/v1/translate", dependencies=[Depends(require_token)])
def translate_text(request: TranslationRequest):
    if not request.text.strip():
        return {"translated_text": "", "detected_language": "unknown"}

    detected = detect(request.text) if request.source == "auto" else request.source
    source = normalize_language(detected)
    target = normalize_language(request.target)
    if source == target:
        return {"translated_text": request.text, "detected_language": source}

    translated = get_translation_batcher().submit(request.text, source, target)
    return {"translated_text": translated, "detected_language": source}


@app.post("/v1/audio/transcriptions", dependencies=[Depends(require_token)])
def transcribe_audio(
    file: UploadFile = File(...),
    model: str = Form(default="large-v3"),
    language: str | None = Form(default=None),
    response_format: str = Form(default="json"),
    diarize: bool = Form(default=False),
):
    del model, response_format, diarize
    if not _asr_capacity.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Transcription queue is full")

    try:
        suffix = Path(file.filename or "voice.ogg").suffix or ".ogg"
        with tempfile.NamedTemporaryFile(suffix=suffix) as temporary:
            while chunk := file.file.read(1024 * 1024):
                temporary.write(chunk)
            temporary.flush()

            if not _asr_slots.acquire(timeout=QUEUE_TIMEOUT_SECONDS):
                raise HTTPException(status_code=504, detail="Transcription queue timeout")
            try:
                segments, info = get_whisper().transcribe(
                    temporary.name,
                    language=None if not language or language == "auto" else language,
                    vad_filter=True,
                    beam_size=5,
                )
                text = " ".join(segment.text.strip() for segment in segments).strip()
            finally:
                _asr_slots.release()
    finally:
        _asr_capacity.release()

    return {
        "text": text,
        "language": info.language or "unknown",
        "confidence": info.language_probability,
    }
