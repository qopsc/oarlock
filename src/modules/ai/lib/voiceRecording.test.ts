import { beforeEach, expect, it, vi } from "vitest";
import { beginComposerWork, cancelComposerWork } from "./composerWork";
import { createVoiceRecording } from "./voiceRecording";

class Recorder {
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    if (this.state === "inactive") throw new Error("already stopped");
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.onstop?.();
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const track = vi.fn();
const stream = { getTracks: () => [{ stop: track }] } as unknown as MediaStream;
const acquire = vi.fn<() => Promise<MediaStream>>();
const transcribe =
  vi.fn<(blob: Blob, signal: AbortSignal) => Promise<string>>();
const state = vi.fn(),
  error = vi.fn(),
  result = vi.fn();
let recorder: Recorder;
let voice: ReturnType<typeof createVoiceRecording>;
const options = {
  begin: () => beginComposerWork("voice-chat"),
  transcribe,
  result,
};
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}
beforeEach(() => {
  cancelComposerWork("voice-chat");
  vi.clearAllMocks();
  acquire.mockReset().mockResolvedValue(stream);
  transcribe.mockReset().mockResolvedValue(" transcript ");
  recorder = new Recorder();
  voice = createVoiceRecording({
    acquire,
    recorder: () => recorder as unknown as MediaRecorder,
    state,
    error,
  });
  voice.setVisible(true);
});
it("explicit microphone Stop transcribes once, releases tracks and permits the next recording", async () => {
  await voice.start(options);
  voice.stop();
  await flush();
  voice.stop();
  expect(transcribe).toHaveBeenCalledOnce();
  expect(result).toHaveBeenCalledWith("transcript");
  expect(track).toHaveBeenCalledOnce();
  expect(state).toHaveBeenLastCalledWith("idle");
  expect(recorder.stop).toHaveBeenCalledOnce();
  await voice.start(options);
  expect(acquire).toHaveBeenCalledTimes(2);
  voice.cancel();
});
it.each(["cancel", "hide", "chat-stop"])(
  "%s discards audio without uploading",
  async (reason) => {
    await voice.start(options);
    if (reason === "cancel") voice.cancel();
    if (reason === "hide") voice.setVisible(false);
    if (reason === "chat-stop") cancelComposerWork("voice-chat");
    await flush();
    expect(transcribe).not.toHaveBeenCalled();
    expect(result).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledOnce();
    expect(state).toHaveBeenLastCalledWith("idle");
  },
);
it("late microphone permission releases its tracks without recording", async () => {
  const pending = deferred<MediaStream>();
  acquire.mockReturnValue(pending.promise);
  const start = voice.start(options);
  await flush();
  voice.setVisible(false);
  pending.resolve(stream);
  await start;
  expect(recorder.start).not.toHaveBeenCalled();
  expect(track).toHaveBeenCalledOnce();
  expect(transcribe).not.toHaveBeenCalled();
});
it("claims acquisition synchronously so double clicks cannot start two microphones", async () => {
  const pending = deferred<MediaStream>();
  acquire.mockReturnValue(pending.promise);
  const first = voice.start(options);
  await voice.start(options);
  expect(acquire).toHaveBeenCalledOnce();
  pending.resolve(stream);
  await first;
  voice.cancel();
});
it("cancellation aborts transcription and ignores a server that still returns a result", async () => {
  const response = deferred<string>();
  transcribe.mockReturnValue(response.promise);
  await voice.start(options);
  voice.stop();
  const signal = transcribe.mock.calls[0][1];
  voice.cancel();
  expect(signal.aborted).toBe(true);
  expect(voice.busy()).toBe(false);
  response.resolve("late text");
  await flush();
  expect(result).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});
it("an old failed request cannot reset a newer recording", async () => {
  const response = deferred<string>();
  transcribe.mockReturnValueOnce(response.promise);
  await voice.start(options);
  voice.stop();
  voice.cancel();
  recorder = new Recorder();
  await voice.start(options);
  response.reject(new Error("old failure"));
  await flush();
  expect(state).toHaveBeenLastCalledWith("recording");
  expect(voice.busy()).toBe(true);
  expect(error).not.toHaveBeenCalled();
  expect(recorder.state).toBe("recording");
  voice.cancel();
});
it("a stale microphone grant cannot release the new recording's tracks", async () => {
  const permission = deferred<MediaStream>();
  acquire.mockReturnValueOnce(permission.promise);
  const old = voice.start(options);
  await flush();
  voice.cancel();
  await voice.start(options);
  const oldTrack = vi.fn();
  permission.resolve({
    getTracks: () => [{ stop: oldTrack }],
  } as unknown as MediaStream);
  await old;
  expect(oldTrack).toHaveBeenCalledOnce();
  expect(track).not.toHaveBeenCalled();
  expect(recorder.state).toBe("recording");
  voice.cancel();
});
it("an invisible composer never acquires the microphone", async () => {
  voice.setVisible(false);
  await voice.start(options);
  expect(acquire).not.toHaveBeenCalled();
});
it("recording errors release the microphone without uploading", async () => {
  await voice.start(options);
  recorder.onerror?.();
  await flush();
  expect(error).toHaveBeenCalledOnce();
  expect(track).toHaveBeenCalledOnce();
  expect(transcribe).not.toHaveBeenCalled();
  expect(state).toHaveBeenLastCalledWith("idle");
  expect(voice.busy()).toBe(false);
});

it("late recorder events cannot revive cancelled audio", async () => {
  await voice.start(options);
  const data = recorder.ondataavailable,
    stopped = recorder.onstop;
  voice.cancel();
  data?.({ data: new Blob(["late audio"]) });
  stopped?.();
  await flush();
  expect(transcribe).not.toHaveBeenCalled();
  expect(result).not.toHaveBeenCalled();
});
it("a recorder that rejects stop still releases its tracks on cancellation", async () => {
  await voice.start(options);
  recorder.stop.mockImplementation(() => {
    throw new Error("broken recorder");
  });
  voice.cancel();
  expect(track).toHaveBeenCalledOnce();
  expect(state).toHaveBeenLastCalledWith("idle");
  expect(transcribe).not.toHaveBeenCalled();
});

it("a failed microphone Stop reports the error and releases the Send barrier", async () => {
  await voice.start(options);
  recorder.stop.mockImplementation(() => {
    throw new Error("recorder disconnected");
  });
  expect(() => voice.stop()).not.toThrow();
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ message: "recorder disconnected" }),
  );
  expect(track).toHaveBeenCalledOnce();
  expect(voice.busy()).toBe(false);
  expect(state).toHaveBeenLastCalledWith("idle");
  expect(transcribe).not.toHaveBeenCalled();
});

it("a stop failure after a stop event aborts transcription already started by that event", async () => {
  const response = deferred<string>();
  transcribe.mockReturnValue(response.promise);
  await voice.start(options);
  recorder.stop.mockImplementation(() => {
    recorder.state = "inactive";
    recorder.ondataavailable?.({ data: new Blob(["audio"]) });
    recorder.onstop?.();
    throw new Error("stop failed");
  });
  voice.stop();
  expect(transcribe).toHaveBeenCalledOnce();
  expect(transcribe.mock.calls[0][1].aborted).toBe(true);
  expect(voice.busy()).toBe(false);
  response.resolve("discard this");
  await flush();
  expect(result).not.toHaveBeenCalled();
  expect(track).toHaveBeenCalledOnce();
});
