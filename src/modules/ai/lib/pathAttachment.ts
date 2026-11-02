import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";

/** The most text one file attachment carries into the prompt, however added. */
export const MAX_TEXT_ATTACHMENT_BYTES = 200_000;

const kb = (bytes: number) => `${Math.ceil(bytes / 1000)} KB`;

/** Why a text file of `size` bytes is not attached. */
export function textTooLarge(size: number): string {
  return `It is ${kb(size)}; a text attachment holds up to ${kb(MAX_TEXT_ATTACHMENT_BYTES)}.`;
}

/** The file name a path's attachment chip shows. */
export function attachmentName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** Native imports validate both spelling and the opened file before returning bytes. */
export type ImportedAttachment =
  | { kind: "text"; name: string; content: string; size: number }
  | {
      kind: "image";
      name: string;
      media_type: string;
      data: string;
      size: number;
    };

export async function readPickedFile(
  path: string,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): Promise<ImportedAttachment> {
  return invoke("ai_import_attachment", { path, workspace, picked: true });
}
export async function readDroppedFile(
  path: string,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): Promise<ImportedAttachment> {
  return invoke("ai_import_attachment", { path, workspace, picked: false });
}
