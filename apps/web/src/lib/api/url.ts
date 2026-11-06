// The one way API URLs are built. The base URL is normalised by the env schema (no trailing
// slash), but this stays defensive so a hand-built client in a test cannot produce `//auth/refresh`.
export function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}
