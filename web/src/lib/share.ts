// v4: send a sign-in link the way people actually send things: copy, WhatsApp, Telegram, or the phone's own share sheet.
import { esc, icon, toast } from "./dom";

export const canShare = () => typeof navigator.share === "function" && matchMedia("(pointer: coarse)").matches;
export const waUrl = (url: string, text: string) => `https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`;
export const tgUrl = (url: string, text: string) => `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;

/** Buttons for one link; bind them once per container with bindShare(). */
export function shareHtml(url: string, text: string, opts: { compact?: boolean } = {}) {
  const a = `data-url="${esc(url)}" data-text="${esc(text)}"`;
  const lbl = (s: string) => (opts.compact ? `<span class="sr-only">${s}</span>` : s);
  return `<div class="share" role="group" aria-label="Linki göndər">
    <button type="button" class="btn sm" data-share="copy" ${a} title="Linki kopyala">${icon("doc")}${lbl("Linki kopyala")}</button>
    <a class="btn sm sh-wa" data-share="wa" href="${esc(waUrl(url, text))}" target="_blank" rel="noopener noreferrer" title="WhatsApp-da göndər">${waIcon}${lbl("WhatsApp")}</a>
    <a class="btn sm sh-tg" data-share="tg" href="${esc(tgUrl(url, text))}" target="_blank" rel="noopener noreferrer" title="Telegram-da göndər">${tgIcon}${lbl("Telegram")}</a>
    ${canShare() ? `<button type="button" class="btn sm" data-share="native" ${a} title="Paylaş">${icon("send")}${lbl("Paylaş")}</button>` : ""}
  </div>`;
}

export function bindShare(root: HTMLElement) {
  root.addEventListener("click", async e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-share]");
    if (!b || b.tagName === "A") return;
    const url = b.dataset.url!, text = b.dataset.text ?? "";
    if (b.dataset.share === "copy") {
      try { await navigator.clipboard.writeText(url); toast("Link kopyalandı"); }
      catch {
        // older phones / plain http: select the text so the user can copy it by hand
        prompt("Linki kopyalayın:", url);
      }
    } else if (b.dataset.share === "native") {
      try { await navigator.share({ title: text, text, url }); } catch { /* cancelled */ }
    }
  });
}

const waIcon = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z"/></svg>`;
const tgIcon = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.9 4.3 18.7 19.4c-.2 1-.9 1.3-1.7.8l-4.8-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.5 13.2 1.8 11.7c-1-.3-1-1 .2-1.5L20.5 3c.9-.3 1.6.2 1.4 1.3Z"/></svg>`;
