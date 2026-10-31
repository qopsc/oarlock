import type { ComposerWork } from "./composerWork";

export type VoiceState = "idle" | "acquiring" | "recording" | "transcribing";
type Run = {
  work: ComposerWork;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  chunks: Blob[];
};

/** One owned recording, including permission acquisition and transcription. */
export function createVoiceRecording(deps: {
  acquire: () => Promise<MediaStream>;
  recorder: (stream: MediaStream) => MediaRecorder;
  state: (state: VoiceState) => void;
  error: (error: unknown) => void;
}) {
  let active: Run | undefined;
  let visible = false;
  const current = (run: Run) => active === run && !run.work.signal.aborted;
  const release = (run: Run) => {
    if (run.recorder) {
      const recorder = run.recorder;
      run.recorder = undefined;
      // stop emits data and stop events asynchronously. Cancellation must never upload.
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // An errored recorder can reject stop; always release its tracks below.
      }
    }
    run.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    run.stream = undefined;
    run.chunks = [];
  };
  const finish = (run: Run) => {
    release(run);
    run.work.finish();
    if (active === run) {
      active = undefined;
      deps.state("idle");
    }
  };
  const cancel = () => active?.work.cancel();
  return {
    busy: () => active !== undefined,
    cancel,
    setVisible(value: boolean) {
      visible = value;
      if (!visible) cancel();
    },
    /** Explicit microphone Stop submits; chat Stop calls cancel instead. */
    stop() {
      const run = active;
      const recorder = run?.recorder;
      if (!run || !recorder || recorder.state === "inactive") return;
      try {
        recorder.stop();
      } catch (error) {
        try {
          if (current(run)) deps.error(error);
        } finally {
          run.work.cancel();
        }
      }
    },
    async start(options: {
      begin: () => (ComposerWork & { admission?: Promise<void> }) | null;
      transcribe: (blob: Blob, signal: AbortSignal) => Promise<string>;
      result: (text: string) => void;
    }) {
      if (!visible || active) return;
      const work = options.begin();
      if (!work || work.signal.aborted) return;
      const run: Run = { work, chunks: [] };
      active = run; // Claim before permission resolves, including double clicks.
      work.onFinish(() => {
        if (work.signal.aborted) finish(run);
      });
      deps.state("acquiring");
      try {
        await work.admission;
        if (!current(run)) return;
        const stream = await deps.acquire();
        if (!current(run)) {
          stream.getTracks().forEach((track) => {
            track.stop();
          });
          return;
        }
        run.stream = stream;
        const recorder = deps.recorder(stream);
        run.recorder = recorder;
        recorder.ondataavailable = (event) => {
          if (current(run) && event.data.size) run.chunks.push(event.data);
        };
        recorder.onerror = () => {
          if (current(run))
            deps.error(new Error("Microphone recording failed"));
          finish(run);
        };
        recorder.onstop = async () => {
          if (!current(run)) return;
          const blob = new Blob(run.chunks, {
            type: recorder.mimeType || "audio/webm",
          });
          release(run);
          if (!blob.size) {
            finish(run);
            return;
          }
          deps.state("transcribing");
          try {
            const text = await options.transcribe(blob, work.signal);
            if (current(run) && text.trim()) options.result(text.trim());
          } catch (error) {
            if (current(run)) deps.error(error);
          } finally {
            finish(run);
          }
        };
        recorder.start();
        deps.state("recording");
      } catch (error) {
        if (current(run)) deps.error(error);
        finish(run);
      }
    },
  };
}
