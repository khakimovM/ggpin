// Telegram's HTML parse mode only treats these three characters as markup.
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

/**
 * Escapes user-controlled text (first_name, links built from input) for `parse_mode: 'HTML'`.
 *
 * Text content only: `"` and `'` are NOT escaped, so an escaped value is safe between tags
 * (`<code>{name}</code>`) but never inside an HTML attribute (`<a href="{param}">`). No template
 * puts a parameter into an attribute; keep it that way (S6 audit I-4).
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => HTML_ESCAPES[char] ?? char);
}
