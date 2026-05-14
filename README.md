# pi-vo

Local voice extension for [Pi](https://github.com/earendil-works/pi-coding-agent) featuring resident ASR/TTS workers for low-latency speech-to-text and text-to-speech.

[![CI](https://github.com/darkhorseprojects/pi-vo/actions/workflows/ci.yml/badge.svg)](https://github.com/darkhorseprojects/pi-vo/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

## Features

- **Live Speech-to-Text**: Cohere-ASR transcribes microphone input in real-time
- **Text-to-Speech**: OmniVoice generates expressive speech with voice design
- **Zero-latency**: Models run as persistent workers, no per-request loading
- **Low VRAM**: 4-bit quantization with CPU offload reduces VRAM to ~6GB
- **Configurable**: Voice personality via voice design parameters

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

The installer creates `.venv-voice`, installs PyTorch, OmniVoice, Cohere-ASR, bitsandbytes, and writes `~/.pi/pi-vo.json`.

## Voice Cloning

For voice cloning, provide a reference audio file and its transcript. The audio should be 15-30 seconds of expressive speech that matches the style you want:

```json
{
  "ttsReferenceAudio": "/path/to/voice-sample.wav",
  "ttsVoiceDesign": "warm, conversational, with emotional range and natural pauses"
}
```

The reference audio must be 16kHz PCM WAV.

### Voice Style Guidance

Use `ttsVoiceDesign` to guide the delivery style (emotional tone, pacing, character):

```json
{
  "ttsVoiceDesign": "warm, conversational, with emotional range and natural pauses"
}
```

This parameter works independently or alongside voice cloning to shape how text is delivered.

## Configuration

Default config at `~/.pi/pi-vo.json`:

```json
{
  "voicePython": "/path/to/pi-vo/.venv-voice/bin/python",
  "asrModel": "cstr/cohere-transcribe-onnx-int4",
  "asrDeviceMap": "cuda:0",
  "asrDtype": "float32",
  "ttsModel": "k2-fsa/OmniVoice",
  "ttsDeviceMap": "cuda:0",
  "ttsDtype": "bfloat16",
  "ttsLoadIn4bit": true,
  "ttsQuantType": "nf4",
  "ttsComputeDtype": "bfloat16",
  "ttsCpuOffload": true,
  "ttsOffloadFolder": "~/.pi/pi-vo-offload",
  "ttsReferenceAudio": "",
  "ttsVoiceDesign": "",
  "ttsNumSteps": 32,
  "voiceSpeed": 1.15,
  "voiceVolume": 0.85,
  "recordSampleRate": 16000,
  "audioSampleRate": 24000
}
```

### Environment Variables

```bash
PI_VO_VOICE_PYTHON=/path/to/.venv-voice/bin/python
PI_VO_ASR_MODEL=cstr/cohere-transcribe-onnx-int4
PI_VO_ASR_DEVICE_MAP=cuda:0
PI_VO_ASR_DTYPE=float32
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
- ~6GB VRAM (with 4-bit quantization and CPU offload)

## License

Apache 2.0 - see [LICENSE](LICENSE) file for details.