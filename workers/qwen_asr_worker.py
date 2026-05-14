import base64
import gc
import json
import os
import sys
import traceback
from dataclasses import dataclass
from typing import Any

model = None
loaded = None

@dataclass(frozen=True)
class LoadedConfig:
    model: str
    device_map: str
    dtype: str
    attn_implementation: str
    max_new_tokens: int
    max_batch_size: int


def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        req_id = req.get("id")
        try:
            result = handle(req)
            send(req_id, True, result=result)
        except Exception as exc:
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            send(req_id, False, error=str(exc))


def handle(req: dict[str, Any]) -> Any:
    op = req.get("op")
    if op == "health":
        return {"ok": True, "loaded": loaded is not None, "stats": stats()}
    if op == "load":
        return load(req)
    if op == "unload":
        unload()
        return {"loaded": False, "stats": stats()}
    if op == "transcribe":
        return transcribe(req)
    raise ValueError(f"Unknown op: {op}")


def load(req: dict[str, Any]) -> dict[str, Any]:
    global model, loaded
    cfg = read_config(req)
    if model is not None and loaded == cfg:
        return {"loaded": True, "model": cfg.model, "stats": stats()}

    unload()
    import torch
    from qwen_asr import Qwen3ASRModel

    torch.set_grad_enabled(False)
    kwargs: dict[str, Any] = {
        "dtype": torch_dtype(torch, cfg.dtype),
        "device_map": cfg.device_map,
        "max_inference_batch_size": cfg.max_batch_size,
        "max_new_tokens": cfg.max_new_tokens,
    }
    if cfg.attn_implementation:
        kwargs["attn_implementation"] = cfg.attn_implementation

    model = Qwen3ASRModel.from_pretrained(cfg.model, **kwargs)
    loaded = cfg
    return {"loaded": True, "model": cfg.model, "stats": stats()}


def transcribe(req: dict[str, Any]) -> dict[str, Any]:
    load(req)
    import numpy as np
    import torch

    audio = decode_pcm16(req["pcm16"])
    sample_rate = int(req.get("sampleRate") or 16000)
    language = req.get("language") or None

    with torch.inference_mode():
        results = model.transcribe(audio=(audio, sample_rate), language=language)

    first = results[0] if isinstance(results, (list, tuple)) else results
    text = extract(first, "text") or ""
    language = extract(first, "language") or language
    return {"text": str(text).strip(), "language": language, "stats": stats()}


def unload() -> None:
    global model, loaded
    model = None
    loaded = None
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


def read_config(req: dict[str, Any]) -> LoadedConfig:
    return LoadedConfig(
        model=str(req.get("model") or "Qwen/Qwen3-ASR-0.6B"),
        device_map=str(req.get("deviceMap") or "cuda:0"),
        dtype=str(req.get("dtype") or "bfloat16"),
        attn_implementation=str(req.get("attnImplementation") or ""),
        max_new_tokens=int(req.get("maxNewTokens") or 128),
        max_batch_size=int(req.get("maxBatchSize") or 1),
    )


def decode_pcm16(encoded: str):
    import numpy as np
    raw = base64.b64decode(encoded)
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def torch_dtype(torch, name: str):
    values = {
        "float32": torch.float32,
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
    }
    if name not in values:
        raise ValueError(f"Unsupported dtype: {name}")
    return values[name]


def extract(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def stats() -> dict[str, Any]:
    out: dict[str, Any] = {"rssMiB": rss_mib()}
    try:
        import torch
        if torch.cuda.is_available():
            device = torch.cuda.current_device()
            out["cudaAllocatedMiB"] = round(torch.cuda.memory_allocated(device) / 1048576, 1)
            out["cudaReservedMiB"] = round(torch.cuda.memory_reserved(device) / 1048576, 1)
    except Exception:
        pass
    return out


def rss_mib() -> float | None:
    try:
        pages = int(open("/proc/self/statm", "r", encoding="utf-8").read().split()[1])
        return round(pages * os.sysconf("SC_PAGE_SIZE") / 1048576, 1)
    except Exception:
        return None


def send(req_id: Any, ok: bool, result: Any = None, error: str | None = None) -> None:
    print(json.dumps({"id": req_id, "ok": ok, "result": result, "error": error}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
