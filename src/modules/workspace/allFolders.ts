import { create } from "zustand";
type StoredSettings = { appAllFolders: boolean; aiAllFolders: boolean };
/** UI mirrors only. Rust applies committed preferences directly to the gates. */
export const useAllFolders = create<{ app: boolean; ai: boolean }>(() => ({
  app: false,
  ai: false,
}));
export function syncAllFolders(store: {
  getState(): StoredSettings;
  subscribe(listener: (state: StoredSettings) => void): () => void;
}): () => void {
  const push = (state: StoredSettings) => {
    const settings = {
      app: state.appAllFolders === true,
      ai: state.aiAllFolders === true,
    };
    const shown = useAllFolders.getState();
    if (shown.app !== settings.app || shown.ai !== settings.ai)
      useAllFolders.setState(settings);
  };
  push(store.getState());
  return store.subscribe(push);
}
