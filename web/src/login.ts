import "./styles.css";
import { api, ApiError } from "./lib/api";
import { $, esc } from "./lib/dom";
import { themeSwitch } from "./lib/theme";
import { brandHtml } from "./lib/topbar";
import { pageOrg } from "./lib/org";

themeSwitch($("#themeSw"));

// orgs: one sign-in page for every organisation, so it names no event (no other customer's name on it);
// /login?org=<slug> shows that organisation's event.
if (pageOrg()) {
  api<{ eventName: string }>("/api/stage").then(s => {
    $("#brand").innerHTML = brandHtml(s.eventName);
    document.title = `Daxil ol · ${s.eventName} · munsif.im`;
  }).catch(() => { /* offline / unknown organisation */ });
} else {
  $("#brand").textContent = "Təşkilat paneli";
}

// This browser may already hold an admin and/or juror session: offer a way back instead of a re-login.
// (asks /api/auth/session first: it never answers 401, so a fresh visitor gets no console error)
let adminPanel = "/admin";
api<{ admin: boolean; juror: boolean; panel: string | null; root: boolean }>("/api/auth/session").then(s => {
  // the platform owner's home is /root (the server says which panel an admin session belongs to)
  if (s.admin && s.root && s.panel === "/root") adminPanel = "/root";
  return s.admin || s.juror ? api<{ sessions: Array<{ role: "admin" | "juror"; displayName: string }> }>("/api/auth/me") : { sessions: [] };
}).then(me => {
  if (!me.sessions.length) return;
  const box = $("#already");
  const label = (role: "admin" | "juror") => role === "juror" ? "Münsif paneli" : adminPanel === "/root" ? "Platforma" : "Canlı panel";
  box.innerHTML = `<b>Bu brauzerdə artıq daxil olmusunuz:</b><div class="row" style="margin-top:8px">${me.sessions.map(s =>
    `<a class="btn sm" href="${s.role === "admin" ? adminPanel : "/juror"}">${esc(s.displayName)} · ${label(s.role)} →</a>`).join("")}</div>
    <p class="sub" style="margin:8px 0 0">Koordinator kimi daxil olmaq üçün aşağıdakı formdan istifadə edin.</p>`;
  box.hidden = false;
}).catch(() => { /* not logged in */ });

const form = $<HTMLFormElement>("#form");
const err = $("#err");
const go = $<HTMLButtonElement>("#go");
$<HTMLInputElement>("#u").focus();

form.addEventListener("submit", async e => {
  e.preventDefault();
  const username = $<HTMLInputElement>("#u").value.trim();
  const password = $<HTMLInputElement>("#p").value;
  if (!username || !password) { err.textContent = "İstifadəçi adını və şifrəni daxil edin."; return; }
  err.textContent = "";
  go.disabled = true;
  go.textContent = "Yoxlanılır…";
  try {
    const r = await api<{ redirect: string }>("/api/auth/login", { method: "POST", body: { username, password } });
    location.href = r.redirect;
  } catch (ex) {
    err.textContent = ex instanceof ApiError ? ex.message : "Xəta baş verdi.";
    $<HTMLInputElement>("#p").select();
    go.disabled = false;
    go.textContent = "Daxil ol";
  }
});
