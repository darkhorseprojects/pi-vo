import base64
import gc
import json
import os
import sys
import warnings
import traceback
import contextlib
from dataclasses import dataclass
from typing import Any

import numpy as np

# Suppress HuggingFace download progress bars
os.environ.setdefault("HF_HUB_VERBOSITY", "error")
warnings.filterwarnings("ignore", category=UserWarning, module="huggingface_hub")


@contextlib.contextmanager
def suppress_stderr():
    """Context manager to suppress all stderr output during model loading."""
    original_stderr = sys.stderr
    sys.stderr = open(os.devnull, "w")
    try:
        yield
    finally:
        sys.stderr.close()
        sys.stderr = original_stderr

model = None
loaded = None

# Model architecture constants
N_LAYERS, N_HEADS, HEAD_DIM, MAX_CTX = 8, 8, 128, 1024

# Prompt tokens for English transcription
PROMPT_TOKENS = [
    "<|startofcontext|>", "<|startoftranscript|>", "<|emo:undefined|>",
    "<|en|>", "<|en|>", "<|pnc|>", "<|noitn|>", "<|notimestamp|>", "<|nodiarize|>"
]


@dataclass(frozen=True)
class LoadedConfig:
    model: str


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
    import onnxruntime as ort

    model_path = cfg.model
    if not os.path.isdir(model_path):
        # Try huggingface hub download (suppress all progress output)
        from huggingface_hub import snapshot_download
        with suppress_stderr():
            model_path = snapshot_download(
                "cstr/cohere-transcribe-onnx-int4",
                local_files_only=False,
            )

    encoder_path = os.path.join(model_path, "cohere-encoder.int4.onnx")
    decoder_path = os.path.join(model_path, "cohere-decoder.int4.onnx")
    tokens_path = os.path.join(model_path, "tokens.txt")

    # Load tokenizer
    tokens = {}
    with open(tokens_path, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.strip().rsplit(" ", 1)
            if len(parts) == 2:
                tokens[int(parts[1])] = parts[0]

    # Build reverse mapping
    token_to_id = {v: k for k, v in tokens.items()}
    eos_token = tokens.get(token_to_id.get("<|endoftext|>", 0), "")

    # Initialize ONNX sessions
    enc_sess = ort.InferenceSession(encoder_path)
    dec_sess = ort.InferenceSession(decoder_path)

    model = {
        "enc": enc_sess,
        "dec": dec_sess,
        "tokens": tokens,
        "token_to_id": token_to_id,
        "eos_id": token_to_id.get("<|endoftext|>"),
        "prompt_ids": [token_to_id.get(t) for t in PROMPT_TOKENS],
    }
    loaded = cfg
    return {"loaded": True, "model": cfg.model, "stats": stats()}


def transcribe(req: dict[str, Any]) -> dict[str, Any]:
    load(req)
    import numpy as np

    audio = decode_pcm16(req["pcm16"])
    sample_rate = int(req.get("sampleRate") or 16000)

    # Resample if needed
    if sample_rate != 16000:
        import librosa
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=16000)

    # Run encoder
    audio_input = audio.reshape(1, -1).astype(np.float32)
    cross_k, cross_v = model["enc"].run(None, {"audio": audio_input})

    # Initialize caches
    self_k = np.zeros((N_LAYERS, 1, N_HEADS, MAX_CTX, HEAD_DIM), dtype=np.float32)
    self_v = np.zeros((N_LAYERS, 1, N_HEADS, MAX_CTX, HEAD_DIM), dtype=np.float32)

    # Decode autoregressively
    generated = list(model["prompt_ids"])
    current = np.array([model["prompt_ids"]], dtype=np.int64)
    offset = np.array(0, dtype=np.int64)

    for _ in range(512):
        logits, self_k, self_v = model["dec"].run(None, {
            "tokens": current,
            "in_n_layer_self_k_cache": self_k,
            "in_n_layer_self_v_cache": self_v,
            "n_layer_cross_k": cross_k,
            "n_layer_cross_v": cross_v,
            "offset": offset,
        })
        next_id = int(np.argmax(logits[0, -1, :]))
        if next_id == model["eos_id"]:
            break
        generated.append(next_id)
        offset = np.array(int(offset) + current.shape[1], dtype=np.int64)
        current = np.array([[next_id]], dtype=np.int64)

    # Decode to text
    text = decode_tokens(generated, model["tokens"], len(model["prompt_ids"]))
    return {"text": text, "language": "en", "stats": stats()}


def decode_tokens(generated: list[int], tokens: dict[int, str], prompt_len: int) -> str:
    """Decode generated token IDs to text."""
    text = "".join(
        tokens.get(t, "").replace("\u2581", " ")
        for t in generated[prompt_len:]
        if not tokens.get(t, "").startswith("<|")
    ).strip()
    return text


def unload() -> None:
    global model, loaded
    model = None
    loaded = None
    gc.collect()


def read_config(req: dict[str, Any]) -> LoadedConfig:
    return LoadedConfig(
        model=str(req.get("model") or "cstr/cohere-transcribe-onnx-int4"),
    )


def decode_pcm16(encoded: str) -> np.ndarray:
    raw = base64.b64decode(encoded)
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def stats() -> dict[str, Any]:
    out: dict[str, Any] = {"rssMiB": rss_mib()}
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