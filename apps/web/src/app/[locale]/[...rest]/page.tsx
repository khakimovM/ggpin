import { notFound } from 'next/navigation';

// Every URL no page matches ends here, so the 404 is rendered by this request inside the locale
// layout. Without it Next serves its prerendered global 404, whose inline scripts carry no
// per-request nonce and are blocked by the CSP. (A /pay URL with no page yet lands here too:
// "pay" is not a locale, so the layout answers 404.)
export default function UnmatchedPage(): never {
  notFound();
}
