import "./styles.css";
import { api, ApiError } from "./lib/api";
import { $, esc } from "./lib/dom";
import { initTheme, themeSwitch } from "./lib/theme";

initTheme();
themeSwitch($("#themeSw"));

// This browser may already hold an admin and/or juror session: offer a way back instead of a re-login.
api<{ sessions: Array<{ role: "admin" | "juror"; displayName: string }> }>("/api/auth/me").then(me => {
  if (!me.sessions.length) return;
  const box = $("#already");
  box.innerHTML = `<b>Bu brauzerdə artıq daxil olmusunuz:</b><div class="row" style="margin-top:8px">${me.sessions.map(s =>
    `<a class="btn sm" href="${s.role === "admin" ? "/admin" : "/juror"}">${esc(s.displayName)} · ${s.role === "admin" ? "Canlı panel" : "Münsif paneli"} →</a>`).join("")}</div>
    <p class="sub" style="margin:8px 0 0">Başqa hesabla daxil olmaq üçün aşağıdakı formdan istifadə edin.</p>`;
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
