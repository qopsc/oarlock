import { preferencesReady as isPreferencesReady } from "@/modules/settings/readiness";
import { assertChatCanStart } from "../store/chatStop";
import { beginComposerWork } from "../lib/composerWork";
import { createVoiceRecording, type VoiceState } from "../lib/voiceRecording";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import {
  useWorkspaceEnvStore,
  workspaceScopeKey,
} from "@/modules/workspace/env";
import {
  sameVoiceConfiguration,
  voiceConfiguration,
} from "../lib/voiceConfiguration";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useChatStore } from "../store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { transcribeAudio } from "../lib/stt";
import { readyKey } from "../lib/credentialState";

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

export function useWhisperRecording({
  onResult,
}: {
  onResult: (text: string) => void;
}) {
  const apiKeys = useChatStore((s) => s.apiKeys);
  const sttProvider = usePreferencesStore((s) => s.sttProvider);
  const preferencesReady = usePreferencesStore(isPreferencesReady);
  const [state, setState] = useState<VoiceState>("idle");
  const [visible, setVisibleState] = useState(false);
  const recording = useRef<ReturnType<typeof createVoiceRecording> | null>(
    null,
  );
  if (!recording.current)
    recording.current = createVoiceRecording({
      acquire: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      recorder: (stream) => {
        const mimeType = pickMime();
        return new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      },
      state: setState,
      error: (error) =>
        toast.error(
          error instanceof Error ? error.message : "Voice input failed",
        ),
    });
  const controller = recording.current;
  const setVisible = useCallback(
    (value: boolean) => {
      controller.setVisible(value);
      setVisibleState(value);
    },
    [controller],
  );

  const hasKey =
    preferencesReady &&
    (sttProvider === "whispercpp" || !!readyKey(apiKeys[sttProvider]));

  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  const start = async () => {
    const settings = usePreferencesStore.getState();
    const keys = useChatStore.getState().apiKeys;
    const config = voiceConfiguration(settings, keys);
    if (
      !supported ||
      !isPreferencesReady(settings) ||
      (config.provider !== "whispercpp" && !config.key)
    )
      return;
    await controller.start({
      begin: () => {
        const chat = useChatStore.getState();
        if (!chat.activeSessionId || !chat.panelOpen) return null;
        const sessionId = chat.activeSessionId;
        const work = beginComposerWork(sessionId);
        const space = useSpaces.getState().activeId;
        const env = workspaceScopeKey(useWorkspaceEnvStore.getState().env);
        work.onFinish(
          useChatStore.subscribe((next) => {
            if (
              next.activeSessionId !== sessionId ||
              !next.panelOpen ||
              !sameVoiceConfiguration(
                config,
                voiceConfiguration(settings, next.apiKeys),
              )
            )
              work.cancel();
          }),
        );
        work.onFinish(
          usePreferencesStore.subscribe((next) => {
            if (
              !isPreferencesReady(next) ||
              !sameVoiceConfiguration(config, voiceConfiguration(next, keys))
            )
              work.cancel();
          }),
        );
        work.onFinish(
          useSpaces.subscribe((next) => {
            if (next.activeId !== space) work.cancel();
          }),
        );
        work.onFinish(
          useWorkspaceEnvStore.subscribe((next) => {
            if (workspaceScopeKey(next.env) !== env) work.cancel();
          }),
        );
        return Object.assign(work, {
          admission: assertChatCanStart(sessionId),
        });
      },
      transcribe: (blob, signal) =>
        transcribeAudio(blob, config.provider, keys, {
          groqSttModel: settings.groqSttModel,
          whispercppBaseURL: settings.whispercppBaseURL,
          signal,
        }),
      result: onResult,
    });
  };
  useEffect(() => () => controller.setVisible(false), [controller]);

  return {
    busy: controller.busy,
    state,
    recording: state === "recording",
    transcribing: state === "transcribing",
    start,
    stop: controller.stop,
    cancel: controller.cancel,
    acquiring: state === "acquiring",
    visible,
    setVisible,
    supported,
    hasKey,
    sttProvider,
  };
}
