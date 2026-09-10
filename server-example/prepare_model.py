from __future__ import annotations

import logging
import os
import shutil
import subprocess
from pathlib import Path


logging.basicConfig(level=os.getenv("WTT_LOG_LEVEL", "INFO"))
logger = logging.getLogger("wtt-model-prepare")


def ensure_translation_model() -> Path:
    source = os.getenv("WTT_TRANSLATION_MODEL", "facebook/nllb-200-3.3B")
    destination = Path(
        os.getenv(
            "WTT_TRANSLATION_CT2_MODEL",
            str(Path(__file__).parent / "models" / "nllb-200-3.3B-ct2"),
        )
    )
    quantization = os.getenv("WTT_TRANSLATION_CONVERSION_TYPE", "float16")

    if (destination / "model.bin").exists():
        logger.info("Using converted translation model at %s", destination)
        return destination
    if destination.exists():
        raise RuntimeError(
            f"Incomplete model directory at {destination}. Remove only this directory and restart."
        )

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f"{destination.name}.converting")
    if temporary.exists():
        shutil.rmtree(temporary)

    logger.info(
        "Converting %s to CTranslate2 (%s). The first startup can take several minutes.",
        source,
        quantization,
    )
    subprocess.run(
        [
            "ct2-transformers-converter",
            "--model",
            source,
            "--output_dir",
            str(temporary),
            "--quantization",
            quantization,
            "--low_cpu_mem_usage",
        ],
        check=True,
    )
    temporary.rename(destination)
    logger.info("Converted model is ready at %s", destination)
    return destination


if __name__ == "__main__":
    ensure_translation_model()
