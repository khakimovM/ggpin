// SYNTHETIC fragment.com pages (phase 5 S7): written by hand on the S0b marker guesses
// (fragment-page.ts), NOT recorded from Fragment. The dry-run keep-alive simulator serves them and
// the tests read them; S8 replaces them with the owner's sanitized recordings. Nothing here is a
// real cookie, hash or name: the hash is a low-entropy placeholder.

/** The placeholder API hash of the synthetic logged-in page. */
export const SYNTHETIC_PAGE_HASH = 'abc123abc123abc123';

export const SYNTHETIC_LOGGED_IN_PAGE = `<!DOCTYPE html>
<html><head><title>Fragment (synthetic)</title></head>
<body>
<div class="tm-header"><div class="tm-menu-tg-account">synthetic account</div>
<a class="tm-menu-logout" href="#">Log out</a></div>
<script>ajInit({"apiUrl":"\\/api?hash=${SYNTHETIC_PAGE_HASH}"});</script>
</body></html>
`;

export const SYNTHETIC_LOGGED_OUT_PAGE = `<!DOCTYPE html>
<html><head><title>Fragment (synthetic)</title></head>
<body>
<div class="tm-header"><button class="btn js-header-login">Log in</button></div>
<script>ajInit({"apiUrl":"\\/api?hash=${SYNTHETIC_PAGE_HASH}"});</script>
</body></html>
`;

/** Neither state: what a changed Fragment layout would look like to the keep-alive. */
export const SYNTHETIC_UNKNOWN_PAGE = `<!DOCTYPE html>
<html><head><title>Fragment (synthetic)</title></head><body><main>maintenance</main></body></html>
`;
