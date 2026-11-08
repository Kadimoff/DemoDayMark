// munsif.im: signed-in visitors get a "Panel" button.
fetch("/api/auth/session", { credentials: "same-origin" }).then(r => r.ok ? r.json() : null).then(s => {
  if (!s || !s.panel) return;
  const a = document.getElementById("navLogin");
  if (a) { a.href = s.panel; a.textContent = a.dataset.panelLabel || "Panel"; }
}).catch(() => {});
