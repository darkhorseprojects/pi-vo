import gc
import inspect
import json
import os
import sys
import warnings
import traceback
import contextlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

# Suppress transformers/optimum download progress bars
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("HF_HUB_VERBOSITY", "error")
warnings.filterwarnings("ignore", category=UserWarning, module="transformers")
warnings.filterwarnings("ignore", category=UserWarning, module="huggingface_hub")

model = None
loaded = None


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

@dataclass(frozen=True)
class LoadedConfig:
    model: str
    device_map: str
    dtype: str
    load_in_4bit: bool
    quant_type: str
    compute_dtype: str
    cpu_offload: bool
    offload_folder: str
    load_asr: bool


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
    if op == "speak":
        return speak(req)
    raise ValueError(f"Unknown op: {op}")


def load(req: dict[str, Any]) -> dict[str, Any]:
    global model, loaded
    cfg = read_config(req)
    if model is not None and loaded == cfg:
        return {"loaded": True, "model": cfg.model, "stats": stats()}

    unload()
    import torch
    from omnivoice import OmniVoice

    torch.set_grad_enabled(False)
    dtype = torch_dtype(torch, cfg.dtype)
    base: dict[str, Any] = {"device_map": cfg.device_map, "dtype": dtype, "load_asr": cfg.load_asr}
    if cfg.cpu_offload and cfg.offload_folder:
        Path(cfg.offload_folder).expanduser().mkdir(parents=True, exist_ok=True)
        base["offload_folder"] = str(Path(cfg.offload_folder).expanduser())
        base["offload_state_dict"] = True
    variants: list[dict[str, Any]] = [base]

    if cfg.load_in_4bit:
        from transformers import BitsAndBytesConfig
        quant_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type=cfg.quant_type,
            bnb_4bit_compute_dtype=torch_dtype(torch, cfg.compute_dtype),
            bnb_4bit_use_double_quant=True,
            llm_int8_enable_fp32_cpu_offload=cfg.cpu_offload,
        )
        variants = [
            {**base, "quantization_config": quant_config},
            {
                **base,
                "load_in_4bit": True,
                "bnb_4bit_quant_type": cfg.quant_type,
                "bnb_4bit_compute_dtype": torch_dtype(torch, cfg.compute_dtype),
            },
        ]

    # Suppress download progress output
    with suppress_stderr():
        model = call_from_pretrained(OmniVoice.from_pretrained, cfg.model, variants, cfg.load_in_4bit)
    loaded = cfg
    return {"loaded": True, "model": cfg.model, "stats": stats()}


def speak(req: dict[str, Any]) -> dict[str, Any]:
    load(req)
    import numpy as np
    import soundfile as sf
    import torch

    text = str(req.get("text") or "").strip()
    if not text:
        raise ValueError("Text is empty")

    reference_audio = str(req.get("referenceAudio") or "").strip()

    output_path = Path(str(req.get("outputPath") or "speech.wav")).expanduser()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sample_rate = int(req.get("sampleRate") or 24000)

    base_kwargs: dict[str, Any] = {
        "text": text,
        "speed": float(req.get("speed") or 1.0),
    }
    if reference_audio:
        base_kwargs["ref_audio"] = reference_audio
    voice_design = str(req.get("voiceDesign") or "").strip()
    if voice_design:
        base_kwargs["instruct"] = voice_design

    variants = generation_variants(base_kwargs, int(req.get("numSteps") or 16))
    with torch.inference_mode():
        generated = call_generate(model.generate, variants)

    audio = to_audio_array(generated, np)
    sf.write(str(output_path), audio, sample_rate, subtype="PCM_16")
    return {"path": str(output_path), "sampleRate": sample_rate, "stats": stats()}


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
        model=str(req.get("model") or "k2-fsa/OmniVoice"),
        device_map=str(req.get("deviceMap") or "cuda:0"),
        dtype=str(req.get("dtype") or "bfloat16"),
        load_in_4bit=bool(req.get("loadIn4bit", True)),
        quant_type=str(req.get("quantType") or "nf4"),
        compute_dtype=str(req.get("computeDtype") or "bfloat16"),
        cpu_offload=bool(req.get("cpuOffload", True)),
        offload_folder=str(req.get("offloadFolder") or ""),
        load_asr=bool(req.get("loadAsr", False)),
    )


def call_from_pretrained(fn: Callable[..., Any], model_id: str, variants: list[dict[str, Any]], quant_required: bool) -> Any:
    expanded: list[dict[str, Any]] = []
    for variant in variants:
        expanded.append(variant)
        if "dtype" in variant:
            alt = dict(variant)
            alt["torch_dtype"] = alt.pop("dtype")
            expanded.append(alt)

    last: Exception | None = None
    for variant in expanded:
        try:
            filtered = filter_kwargs(fn, variant)
            if quant_required and not carries_quantization(filtered):
                raise TypeError("OmniVoice.from_pretrained did not accept quantization kwargs")
            return fn(model_id, **filtered)
        except TypeError as exc:
            last = exc
    if last:
        raise last
    raise RuntimeError("Unable to load OmniVoice")


def generation_variants(base_kwargs: dict[str, Any], num_steps: int) -> list[dict[str, Any]]:
    variants = [{**base_kwargs, "num_step": num_steps}]
    try:
        from omnivoice import OmniVoiceGenerationConfig
        variants.append({**base_kwargs, "generation_config": OmniVoiceGenerationConfig(num_step=num_steps)})
    except Exception:
        pass
    return variants


def call_generate(fn: Callable[..., Any], variants: list[dict[str, Any]]) -> Any:
    last: Exception | None = None
    for kwargs in variants:
        try:
            return fn(**filter_kwargs(fn, kwargs))
        except TypeError as exc:
            last = exc
    if last:
        raise last
    raise RuntimeError("Unable to generate audio")


def filter_kwargs(fn: Callable[..., Any], kwargs: dict[str, Any]) -> dict[str, Any]:
    signature = inspect.signature(fn)
    params = signature.parameters
    if any(param.kind == inspect.Parameter.VAR_KEYWORD for param in params.values()):
        return kwargs
    return {key: value for key, value in kwargs.items() if key in params}


def carries_quantization(kwargs: dict[str, Any]) -> bool:
    return "quantization_config" in kwargs or kwargs.get("load_in_4bit") is True


def to_audio_array(generated: Any, np):
    import torch

    value = generated
    if isinstance(value, dict):
        for key in ("audio", "wav", "waveform"):
            if key in value:
                value = value[key]
                break
    if isinstance(value, (list, tuple)):
        value = value[0]
    if torch.is_tensor(value):
        value = value.detach().float().cpu().numpy()
    array = np.asarray(value, dtype=np.float32)
    array = np.squeeze(array)
    if array.ndim == 2:
        if array.shape[0] <= 2:
            array = array.mean(axis=0)
        else:
            array = array.mean(axis=1)
    if array.ndim != 1:
        raise ValueError(f"Unexpected audio shape: {array.shape}")
    return np.clip(array, -1.0, 1.0)


def torch_dtype(torch, name: str):
    values = {
        "float32": torch.float32,
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
    }
    if name not in values:
        raise ValueError(f"Unsupported dtype: {name}")
    return values[name]


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
