/** Makes a catalog string safe inside a RegExp ("To‘lash" is fine, "5+ (x)" is not). */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
