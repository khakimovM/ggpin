import { create } from 'zustand';

// UI-only state of the product page: what is highlighted and which sheet is open. Nothing here
// is a price or a balance, and nothing is persisted; the server data (product, quote) lives in
// TanStack Query. The page resets it when the visitor opens another product.
export type ProductSheet = 'help' | 'checkout';

interface ProductUiState {
  selectedSku: string | null;
  /** Digits as typed in the quantity field; null = untouched (the field shows the catalog's minimum). */
  customQty: string | null;
  openSheet: ProductSheet | null;
  selectSku: (skuId: string | null) => void;
  setCustomQty: (value: string) => void;
  setSheet: (sheet: ProductSheet | null) => void;
  reset: () => void;
}

export const useProductUiStore = create<ProductUiState>((set) => ({
  selectedSku: null,
  customQty: null,
  openSheet: null,
  selectSku: (selectedSku) => set({ selectedSku }),
  setCustomQty: (customQty) => set({ customQty }),
  setSheet: (openSheet) => set({ openSheet }),
  reset: () => set({ selectedSku: null, customQty: null, openSheet: null }),
}));
