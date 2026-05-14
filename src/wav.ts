export interface WavData {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcm: Buffer;
}

export function readPcmWav(buffer: Buffer): WavData {
  if (buffer.length < 44) throw new Error("WAV file is too small");
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Expected RIFF/WAVE audio");
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let format = 0;
  let data: Buffer | undefined;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) throw new Error(`Invalid WAV chunk ${id}`);

    if (id === "fmt ") {
      format = buffer.readUInt16LE(start);
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    } else if (id === "data") {
      data = buffer.subarray(start, end);
    }
    offset = end + (size % 2);
  }

  if (format !== 1) throw new Error("Expected PCM WAV");
  if (!data) throw new Error("WAV data chunk missing");
  if (bitsPerSample !== 16) throw new Error("Expected 16-bit WAV");
  if (channels !== 1) throw new Error("Expected mono WAV");
  return { sampleRate, channels, bitsPerSample, pcm: data };
}
