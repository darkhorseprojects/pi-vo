# pi-vo

Local voice extension for [Pi](https://github.com/earendil-works/pi-coding-agent) featuring resident ASR/TTS workers for low-latency speech-to-text and text-to-speech.

[![CI](https://github.com/earendil-works/pi-vo/actions/workflows/ci.yml/badge.svg)](https://github.com/earendil-works/pi-vo/actions/workflows/ci.yml)

## Features

- **Live Speech-to-Text**: Qwen3-ASR transcribes microphone input in real-time
- **Text-to-Speech**: OmniVoice generates expressive speech with voice cloning
- **Zero-latency**: Models run as persistent workers, no per-request loading
- **Low VRAM**: 4-bit quantization keeps VRAM usage minimal
- **Configurable**: Voice personality via prompt audio/text and design notes

## Usage

```
/v              Warm models and toggle live microphone
ctrl+space      Same as /v (toggle recording)
/v 0-100        Set volume (0-100%)
/v stop         Stop all recording, playback, and workers
/v unload       Stop models and hide the orb
/v stt [model]  Show or switch ASR model
/v tts          Show TTS backend settings
/v i [n]        List/select input devices
/v o [n]        List/select output devices
esc             Stop current speech/playback
enter           Clear transcript preview
```

## Installation

```bash
npm install
npm run typecheck
scripts/install.sh
```

The installer creates `.venv-voice`, installs PyTorch, OmniVoice, qwen-asr, bitsandbytes, and writes `~/.pi/pi-vo.json`.

## Voice Cloning

Set both `ttsPromptAudio` and `ttsPromptText` in your config for voice cloning. The prompt should be 10-30 seconds of expressive speech matching the desired voice.

```json
{
  "ttsPromptAudio": "/path/to/voice-sample.wav",
  "ttsVoiceDesign": "female, warm, expressive, mid-range pitch"
}
```

## Configuration

Default config at `~/.pi/pi-vo.json`:

```json
{
  "voicePython": "/path/to/pi-vo/.venv-voice/bin/python",
  "asrModel": "Qwen/Qwen3-ASR-0.6B",
  "asrDeviceMap": "cuda:0",
  "asrDtype": "bfloat16",
  "ttsModel": "k2-fsa/OmniVoice",
  "ttsDeviceMap": "cuda:0",
  "ttsDtype": "bfloat16",
  "ttsLoadIn4bit": true,
  "ttsQuantType": "nf4",
  "ttsComputeDtype": "bfloat16",
  "ttsCpuOffload": true,
  "ttsOffloadFolder": "~/.pi/pi-vo-offload",
  "ttsPromptAudio": "",
  "ttsPromptText": "",
  "ttsVoiceDesign": "",
  "ttsNumSteps": 16,
  "voiceSpeed": 1.15,
  "voiceVolume": 0.85,
  "recordSampleRate": 16000,
  "audioSampleRate": 24000
}
```

### Environment Variables

```bash
PI_VO_VOICE_PYTHON=/path/to/.venv-voice/bin/python
PI_VO_ASR_MODEL=Qwen/Qwen3-ASR-0.6B
PI_VO_ASR_DEVICE_MAP=cuda:0
PI_VO_ASR_DTYPE=bfloat16
PI_VO_TTS_MODEL=k2-fsa/OmniVoice
PI_VO_TTS_DEVICE_MAP=cuda:0
PI_VO_TTS_DTYPE=bfloat16
PI_VO_TTS_LOAD_IN_4BIT=1
PI_VO_TTS_QUANT_TYPE=nf4
PI_VO_TTS_COMPUTE_DTYPE=bfloat16
PI_VO_TTS_CPU_OFFLOAD=1
```

## Requirements

- Node.js 20+
- Python 3.12+
- CUDA-compatible GPU
- PipeWire or PulseAudio
- ~12GB VRAM (with 4-bit quantization)