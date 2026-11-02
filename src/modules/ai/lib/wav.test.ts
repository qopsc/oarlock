import { expect, it } from "vitest";
import { encodeMonoWav } from "./wav";

it.each([
  {
    name: "mono",
    channels: [[0, 1, -1, 0.5]],
    expected: [0, 32767, -32768, 16383],
  },
  {
    name: "right-channel microphone",
    channels: [
      [0, 0],
      [1, -1],
    ],
    expected: [16383, -16384],
  },
  {
    name: "matching stereo",
    channels: [
      [1, -1],
      [1, -1],
    ],
    expected: [32767, -32768],
  },
  {
    name: "four microphone channels",
    channels: [[0], [0], [0], [1]],
    expected: [8191],
  },
  { name: "clipping", channels: [[2, -2]], expected: [32767, -32768] },
])(
  "$name preserves duration and produces normalized mono PCM",
  async ({ channels, expected }) => {
    const input = channels.map((channel) => Float32Array.from(channel));
    const wav = encodeMonoWav({
      length: expected.length,
      sampleRate: 48000,
      numberOfChannels: input.length,
      getChannelData: (index) => input[index],
    });
    expect(wav.type).toBe("audio/wav");
    const bytes = await wav.arrayBuffer();
    const view = new DataView(bytes);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(96000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(expected.length * 2);
    expect(bytes.byteLength).toBe(44 + expected.length * 2);
    expect(
      expected.map((_, index) => view.getInt16(44 + index * 2, true)),
    ).toEqual(expected);
    expect(input.map((channel) => [...channel])).toEqual(channels);
  },
);
