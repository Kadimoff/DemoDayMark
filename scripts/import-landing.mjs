#!/usr/bin/env node
// Imports the munsif.im landing (AZ "/" + EN "/en/") from the munsif-landing build into assets/landing,
// rewiring its asset paths under /landing/ and its call-to-action buttons to this app's routes.
// Usage: node scripts/import-landing.mjs [path/to/munsif-landing/dist]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(process.argv[2] ?? path.join(process.env.HOME ?? "", "projects/munsif-landing/dist"));
const out = path.join(root, "assets/landing");
if (!fs.existsSync(path.join(src, "index.html"))) { console.error(`Landing build not found: ${src}`); process.exit(1); }

fs.rmSync(out, { recursive: true, force: true });
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (/\.(br|gz)$/.test(e.name)) continue; // the server compresses on the fly
    if (e.isDirectory()) copyDir(path.join(from, e.name), path.join(to, e.name));
  }
};
for (const d of ["css", "js", "img", "fonts"]) {
  copyDir(path.join(src, d), path.join(out, d));
  for (const f of fs.readdirSync(path.join(src, d))) if (!/\.(br|gz)$/.test(f)) fs.copyFileSync(path.join(src, d, f), path.join(out, d, f));
}

function must(s, from, to, label) {
  if (!s.includes(from)) throw new Error(`landing import: "${label ?? from}" not found`);
  return s.split(from).join(to);
}

const CTA = {
  az: { login: "Daxil ol", team: "Komanda girişi", demo: "Demo səhnə", panel: "Panel",
    q1: ["munsif.im və munsif.az arasında fərq nədir?", "Platformaya necə daxil olunur?"],
    a1: "Koordinator \"Daxil ol\" düyməsi ilə girir. Münsiflər koordinatorun göstərdiyi QR kodu skan edir, komandalar isə koordinatorun göndərdiyi linki açır. Hamısı bu saytdadır." },
  en: { login: "Sign in", team: "Team sign-in", demo: "Demo stage", panel: "Dashboard",
    q1: ["What is the difference between munsif.im and munsif.az?", "How do people sign in?"],
    a1: "Coordinators use “Sign in”. Judges scan the QR code the coordinator shows them, and teams open the link the coordinator sends. It all happens on this site." },
};

function rewrite(html, lang) {
  const c = CTA[lang];
  let s = html;
  s = s.replaceAll('href="/css/', 'href="/landing/css/').replaceAll('src="/js/', 'src="/landing/js/');
  s = s.replaceAll("/img/", "/landing/img/").replaceAll('href="/fonts/', 'href="/landing/fonts/');
  s = s.replaceAll('href="/apple-touch-icon.png"', 'href="/brand/apple-touch-icon.png"').replaceAll('href="/site.webmanifest"', 'href="/landing/site.webmanifest"');
  s = s.replaceAll("https://munsif.im/og-image.png", "https://munsif.im/brand/og-image.png");
  // The hero stays exactly as designed: only the CTA targets change ("Tədbir yarat" → /login, demo → /stage/demo).
  // The header gets an extra "Daxil ol" link (becomes "Panel" for a signed-in visitor, see session.js).
  s = s.replace(/<a class="btn btn-sm btn-primary magnetic" href="http:\/\/169\.58\.163\.254:7575\/">([^<]*)<\/a>/,
    (_m, label) => `<a class="btn btn-sm btn-ghost magnetic nav-login" id="navLogin" data-panel-label="${c.panel}" href="/login">${c.login}</a><a class="btn btn-sm btn-primary magnetic" href="/login">${label}</a>`);
  s = s.replaceAll("http://169.58.163.254:7575/stage/demo", "/stage/demo");
  s = s.replaceAll('href="http://169.58.163.254:7575/"', 'href="/login"');
  if (s.includes("169.58.163.254")) throw new Error("landing import: an IP link is left");
  s = must(s, '<a href="https://munsif.az">munsif.az</a>', `<a href="/login">${c.login}</a><a href="/team">${c.team}</a>`, "footer munsif.az");
  s = must(s, c.q1[0], c.q1[1]);
  s = s.replace(/(<\/summary>\s*<div[^>]*>\s*<p>|<\/summary>\s*<p>)[^<]*munsif\.az[^<]*/, (_m, pre) => `${pre}${c.a1}`);
  if (s.includes("munsif.az")) {
    // FAQ answer markup may differ: replace the remaining sentence that explains the two domains.
    s = s.replace(/[^<>]*munsif\.az[^<>]*/g, c.a1);
  }
  s = must(s, "</body>", '<script src="/landing/js/session.js" defer></script>\n</body>', "body end");
  return s;
}

fs.writeFileSync(path.join(out, "index.html"), rewrite(fs.readFileSync(path.join(src, "index.html"), "utf8"), "az"));
fs.mkdirSync(path.join(out, "en"), { recursive: true });
fs.writeFileSync(path.join(out, "en", "index.html"), rewrite(fs.readFileSync(path.join(src, "en", "index.html"), "utf8"), "en"));

let css = fs.readFileSync(path.join(out, "css/site.css"), "utf8");
css = css.replaceAll("url(/fonts/", "url(/landing/fonts/");
// the extra header link hides on narrow phones, so the phone header stays exactly as designed
css += "\n.nav-login{white-space:nowrap;margin-right:8px}@media (max-width:640px){.nav-login{display:none}}\n";
fs.writeFileSync(path.join(out, "css/site.css"), css);

const manifest = JSON.parse(fs.readFileSync(path.join(src, "site.webmanifest"), "utf8"));
manifest.icons = manifest.icons.map(i => ({ ...i, src: `/brand/${path.basename(i.src)}` }));
fs.writeFileSync(path.join(out, "site.webmanifest"), JSON.stringify(manifest, null, 2));

// A signed-in visitor gets "Panel" instead of "Daxil ol" (the session endpoint never answers 401).
fs.writeFileSync(path.join(out, "js/session.js"), `// munsif.im: signed-in visitors get a "Panel" button.
fetch("/api/auth/session", { credentials: "same-origin" }).then(r => r.ok ? r.json() : null).then(s => {
  if (!s || !s.panel) return;
  const a = document.getElementById("navLogin");
  if (a) { a.href = s.panel; a.textContent = a.dataset.panelLabel || "Panel"; }
}).catch(() => {});
`);
console.log(`landing imported from ${src} → ${path.relative(root, out)}`);
