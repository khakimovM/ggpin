import { create } from 'zustand';

// UI-only state: what is typed in the catalog search box. The box (in the web header or on the
// Mini App home) and the catalog below it are different components, so the text lives here. The
// debounced, sanitised value that is sent to the API is derived from it (useCatalogSearch).
interface CatalogSearchState {
  text: string;
  setText: (text: string) => void;
  clear: () => void;
}

export const useCatalogSearchStore = create<CatalogSearchState>((set) => ({
  text: '',
  setText: (text) => set({ text }),
  clear: () => set({ text: '' }),
}));
