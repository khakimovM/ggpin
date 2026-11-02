// Telegram's HTML parse mode only treats these three characters as markup.
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

/** Escapes user-controlled text (first_name, links built from input) for `parse_mode: 'HTML'`. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => HTML_ESCAPES[char] ?? char);
}
