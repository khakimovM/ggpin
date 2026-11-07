// Runs before the first paint, so the page never flashes the wrong theme. The ThemeProvider takes
// over after hydration and reads the same sources (it writes the same attribute).
//
// web: the stored choice (`ggpin-theme`: light | dark | system) or, without one, the OS setting;
// `ggpin-reduced-motion` switches animation off the same way. Storage is read inside try/catch:
// it can be blocked in embedded web views.
export const WEB_THEME_SCRIPT = `try{var t=localStorage.getItem('ggpin-theme');var d=t==='dark'||((t!=='light')&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';if(localStorage.getItem('ggpin-reduced-motion')==='true')document.documentElement.dataset.reduced='true'}catch(e){}`;

// tg: Telegram's own colour scheme. The SDK script is loaded by Next before hydration, i.e. AFTER
// this script, so `Telegram.WebApp` usually does not exist yet. The SDK itself decides the scheme
// from the `bg_color` of the theme parameters Telegram puts in the URL hash (or the copy it keeps
// in sessionStorage) with the same brightness rule (below 120 is dark); this repeats that rule.
// Only the theme parameter is read from the hash, nothing else of it is copied or kept.
export const TG_THEME_SCRIPT = `try{var r=document.documentElement,w=window.Telegram&&window.Telegram.WebApp,d=false;if(w&&w.colorScheme){d=w.colorScheme==='dark'}else{var p=null,q=location.hash.slice(1).split('&');for(var i=0;i<q.length;i++){if(q[i].indexOf('tgWebAppThemeParams=')===0)p=decodeURIComponent(q[i].slice(20))}if(!p)p=sessionStorage.getItem('__telegram__themeParams');var c=p&&JSON.parse(p).bg_color;if(typeof c==='string'&&/^#[0-9a-f]{6}$/i.test(c)){var n=parseInt(c.slice(1),16),R=n>>16,G=(n>>8)&255,B=n&255;d=Math.sqrt(.299*R*R+.587*G*G+.114*B*B)<120}}r.dataset.theme=d?'dark':'light'}catch(e){}`;
