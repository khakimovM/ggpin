/**
 * A full page load, not a client-side route change. Used after a sign-out or a lost session:
 * the whole JS state goes with the old page, including the observers of mounted mutations whose
 * last result (a card number, a pay link) the query cache cannot clear.
 */
export function hardNavigate(url: string): void {
  window.location.assign(url);
}
