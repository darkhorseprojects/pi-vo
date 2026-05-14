#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${PI_VO_CONFIG_PATH:-$HOME/.pi/pi-vo.json}"
SETTINGS_PATH="${PI_VO_SETTINGS_PATH:-$HOME/.pi/agent/settings.json}"
VENV="${PI_VO_VENV:-$ROOT/.venv-voice}"
PYTHON_BIN="${PI_VO_PYTHON:-python3}"
TORCH_INDEX_URL="${PI_VO_TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu128}"
EXTENSION_URL="${PI_VO_EXTENSION_URL:-git:github.com/darkhorseprojects/pi-vo}"

log() { printf '\n==> %s\n' "$1"; }
need() { command -v "$1" >/dev/null 2>&1 || { printf 'Missing command: %s\n' "$1" >&2; exit 1; }; }

need "$PYTHON_BIN"
need node

log "Creating Python environment"
"$PYTHON_BIN" -m venv "$VENV"
"$VENV/bin/python" -m pip install -U pip wheel setuptools

log "Installing voice runtime"
"$VENV/bin/python" -m pip install -U torch torchaudio --index-url "$TORCH_INDEX_URL"
"$VENV/bin/python" -m pip install -U \
  accelerate \
  bitsandbytes \
  huggingface-hub \
  numpy \
  transformers \
  omnivoice \
  safetensors \
  scipy \
  soundfile \
  librosa \
  pytz \
  nagisa \
  soynlp \
  qwen-omni-utils
# qwen-asr has an overly strict transformers==4.57.6 pin, but works with transformers 5.x
"$VENV/bin/python" -m pip install --no-deps qwen-asr

if [[ "${PI_VO_INSTALL_FLASH_ATTN:-0}" == "1" ]]; then
  log "Installing flash-attn"
  MAX_JOBS="${MAX_JOBS:-4}" "$VENV/bin/python" -m pip install -U flash-attn --no-build-isolation
fi

log "Writing pi-vo config"
mkdir -p "$(dirname "$CONFIG_PATH")"
CONFIG_PATH="$CONFIG_PATH" ROOT="$ROOT" VENV="$VENV" node <<'NODE'
const fs = require("node:fs");
const path = process.env.CONFIG_PATH;
const root = process.env.ROOT;
const venv = process.env.VENV;
const defaults = {
  showOrb: true,
  showStatus: true,
  showMemory: true,
  audioDir: `${process.env.HOME}/.pi/pi-vo-audio`,
  recordSampleRate: 16000,
  audioSampleRate: 24000,
  audioChannels: 1,
  micDevice: "@DEFAULT_SOURCE@",
  outputDevice: "@DEFAULT_SINK@",
  recordStreamCommand: "pw-record --raw --rate {sampleRate} --channels 1 --format s16 --target {device} -",
  playStreamCommand: "pw-cat --playback --raw --rate {sampleRate} --channels {channels} --format s16 --target {device} --volume {volume} -",
  voiceVolume: 0.85,
  voiceSpeed: 1.15,
  autoSend: false,
  autoSendDelayMs: 650,
  voiceSummaryMaxChars: 320,
  voicePython: `${venv}/bin/python`,
  asrModel: "Qwen/Qwen3-ASR-0.6B",
  asrDeviceMap: "cuda:0",
  asrDtype: "bfloat16",
  asrLanguage: null,
  asrAttnImplementation: "",
  asrMaxNewTokens: 128,
  asrMaxBatchSize: 1,
  ttsModel: "k2-fsa/OmniVoice",
  ttsDeviceMap: "cuda:0",
  ttsDtype: "bfloat16",
  ttsLoadIn4bit: true,
  ttsQuantType: "nf4",
  ttsComputeDtype: "bfloat16",
  ttsCpuOffload: true,
  ttsOffloadFolder: `${process.env.HOME}/.pi/pi-vo-offload`,
  ttsPromptAudio: "",
  ttsPromptText: "",
  ttsVoiceDesign: "",
  ttsNumSteps: 16
};
const current = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
const next = {};
for (const [key, value] of Object.entries(defaults)) {
  next[key] = Object.prototype.hasOwnProperty.call(current, key) ? current[key] : value;
}
next.voicePython = defaults.voicePython;
fs.writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
NODE

log "Registering pi extension"
mkdir -p "$(dirname "$SETTINGS_PATH")"
SETTINGS_PATH="$SETTINGS_PATH" EXTENSION_URL="$EXTENSION_URL" node <<'NODE'
const fs = require("node:fs");
const path = process.env.SETTINGS_PATH;
const url = process.env.EXTENSION_URL;
const settings = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
settings.packages = Array.isArray(settings.packages) ? settings.packages : [];
if (!settings.packages.includes(url)) settings.packages.push(url);
fs.writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
NODE

cat <<EOF

pi-vo is installed.
Config: $CONFIG_PATH
Python: $VENV/bin/python
Use /v or ctrl+space inside Pi to warm and toggle the microphone.
EOF
