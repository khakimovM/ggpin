// Response shapes the catalog e2e suites read; kept apart from the app/fixture bootstrap.
export interface Envelope {
  readonly success: boolean;
  readonly data?: unknown;
  readonly meta?: unknown;
  readonly error?: { readonly code: string };
}
export interface CategoryOut {
  readonly slug: string;
  readonly name: string;
  readonly productCount: number;
}
export interface ProductOut {
  readonly slug: string;
  readonly name: string;
  readonly fromPriceTiyin: string | null;
  readonly inStock: boolean;
}
export interface DetailOut {
  readonly name: string;
  readonly description: string | null;
  readonly help: string | null;
  readonly stock: number | null;
  readonly unitPriceTiyin: string | null;
  readonly skus: readonly { readonly label: string; readonly fromPriceTiyin: string | null }[];
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: Record<string, unknown>;
  readonly body: Envelope;
}
