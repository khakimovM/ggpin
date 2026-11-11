import { create } from 'zustand';

// UI-only state of the web store's top-up modal: whether it is open. The amount, the request and
// its status are not here (the form keeps what is typed; the request lives in TanStack Query).
interface TopupModalState {
  open: boolean;
  show: () => void;
  hide: () => void;
}

export const useTopupModalStore = create<TopupModalState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
