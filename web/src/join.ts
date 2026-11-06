// QR landing page (/j/<token>): the juror types their name once and lands in the juror panel.
import "./styles.css";
import { api, ApiError } from "./lib/api";
import { $, esc, icon } from "./lib/dom";
import { initTheme } from "./lib/theme";
import { brandHtml } from "./lib/topbar";

initTheme();

const token = location.pathname.split("/").filter(Boolean)[1] ?? "";
const box = $("#box");

function fail(msg: string) {
  box.innerHTML = `
    <div class="stack" style="gap:12px">
      <div class="banner err">${icon("warn")}<span>${esc(msg)}</span></div>
      <p class="sub" style="margin:0">Koordinator sizin üçün yeni QR kod yarada bilər. Ballarınız itmir.</p>
      <a class="btn" href="/juror">Münsif panelinə keç</a>
    </div>`;
}

async function start() {
  let info: { currentName: string; eventName: string; date: string };
  try {
    info = await api(`/api/auth/invite/${encodeURIComponent(token)}`);
  } catch (e) {
    fail((e as ApiError).message);
    return;
  }
  $("#brand").innerHTML = brandHtml(info.eventName);
  $("#evDate").textContent = `Münsif girişi${info.date ? ` · ${info.date}` : ""}`;
  document.title = `Münsif girişi · ${info.eventName}`;
  box.innerHTML = `
    <form id="form" class="stack" novalidate style="gap:16px">
      <div>
        <div class="join-hello">${info.currentName ? `Yenidən xoş gəldiniz` : "Xoş gəldiniz!"}</div>
        <p class="sub">${info.currentName ? "Adınızı yoxlayın və davam edin. Əvvəlki ballarınız yerindədir." : "Adınız münsif panelində və koordinatorun ekranında görünəcək."}</p>
      </div>
      <div><label class="f" for="nm">Adınız və soyadınız</label>
        <input type="text" id="nm" name="name" autocomplete="name" autocapitalize="words" maxlength="80" value="${esc(info.currentName)}" placeholder="məs. Rəşad Əliyev" required></div>
      <p class="err-t" id="err" role="alert"></p>
      <button class="btn primary lg" id="go" type="submit">Qiymətləndirməyə başla ${icon("next")}</button>
    </form>`;
  const input = $<HTMLInputElement>("#nm");
  input.focus();
  $("#form").addEventListener("submit", async e => {
    e.preventDefault();
    const displayName = input.value.trim().replace(/\s+/g, " ");
    const err = $("#err");
    if (displayName.length < 2) { err.textContent = "Adınızı və soyadınızı yazın."; input.focus(); return; }
    const go = $<HTMLButtonElement>("#go");
    go.disabled = true;
    go.textContent = "Daxil olunur…";
    try {
      const r = await api<{ redirect: string; displayName: string }>(`/api/auth/invite/${encodeURIComponent(token)}`, { method: "POST", body: { displayName } });
      box.innerHTML = `<div class="join-ok"><span class="tick">${icon("check")}</span><div class="join-hello">${esc(r.displayName)}</div><p class="sub" style="margin:0">Münsif panelinə keçirsiniz…</p></div>`;
      setTimeout(() => location.replace(r.redirect), 700);
    } catch (ex) {
      const a = ex as ApiError;
      if (a.status === 410) { fail(a.message); return; }
      err.textContent = a.message;
      go.disabled = false;
      go.innerHTML = `Qiymətləndirməyə başla ${icon("next")}`;
    }
  });
}

start();
