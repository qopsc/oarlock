/** Encode decoded microphone channels as mono PCM16 without dropping a channel. */
export function encodeMonoWav(
  buf: Pick<
    AudioBuffer,
    "length" | "sampleRate" | "numberOfChannels" | "getChannelData"
  >,
): Blob {
  const length = buf.length;
  const sampleRate = buf.sampleRate;
  const channels = Array.from({ length: buf.numberOfChannels }, (_, index) =>
    buf.getChannelData(index),
  );
  const dataLen = length * 2;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++)
      view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataLen, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    let sample = channels[0][i];
    for (let channel = 1; channel < channels.length; channel++)
      sample += channels[channel][i];
    const s = Math.max(-1, Math.min(1, sample / channels.length));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}
