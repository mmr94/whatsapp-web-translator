from __future__ import annotations

import os

import uvicorn

from prepare_model import ensure_translation_model


if __name__ == "__main__":
    ensure_translation_model()
    uvicorn.run(
        "app:app",
        host=os.getenv("WTT_HOST", "0.0.0.0"),
        port=int(os.getenv("WTT_PORT", "8000")),
        workers=1,
        access_log=os.getenv("WTT_ACCESS_LOG", "0") == "1",
    )
