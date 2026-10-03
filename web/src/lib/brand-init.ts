// Shared between the server (root layout) and the browser: the cookie that remembers a person's own light/dark choice and the
// small script that runs before the first paint, so a reload never shows the wrong mode and safe mode works without the API.

export const MODE_COOKIE = "fledge_mode";
export const SAFE_KEY = "fledge-safe";
export type PersonalMode = "dark" | "light" | "system";
export const isPersonalMode = (v: unknown): v is PersonalMode => v === "dark" || v === "light" || v === "system";

/**
 * Runs in <head>. The html element carries data-default (the administrator's mode) and data-allow (may people choose?).
 * Safe mode (?safe=1, remembered for the tab; ?safe=0 leaves it) switches off the theme and custom CSS and falls back to the built-in look.
 * The style elements are disabled rather than removed, because removing server-rendered nodes makes React rebuild the page and undo it.
 */
export const INIT_SCRIPT = `(function(){var d=document.documentElement;try{
var q=location.search;
if(/[?&]safe=0(&|$)/.test(q))sessionStorage.removeItem("${SAFE_KEY}");else if(/[?&]safe=1(&|$)/.test(q))sessionStorage.setItem("${SAFE_KEY}","1");
if(sessionStorage.getItem("${SAFE_KEY}")==="1"){["brand-vars","brand-css"].forEach(function(i){var e=document.getElementById(i);if(e)e.setAttribute("media","not all")});d.setAttribute("data-mode","dark");d.setAttribute("data-safe","");d.className="dark";return}
var m=(document.cookie.match(/(?:^|; )${MODE_COOKIE}=(dark|light|system)/)||[])[1];
var want=d.getAttribute("data-allow")==="1"&&m?m:d.getAttribute("data-default")||"dark";
var mq=matchMedia("(prefers-color-scheme: light)");
function apply(){var v=want==="system"?(mq.matches?"light":"dark"):want;d.setAttribute("data-mode",v);d.classList.toggle("dark",v==="dark")}
apply();if(want==="system"&&mq.addEventListener)mq.addEventListener("change",apply)
}catch(e){}})();`;
