// Drag-to-reorder with a placeholder: grab an item by its handle, a dashed gap shows where it will land,
// drop to commit. Pointer events, so mouse, pen and touch all work. Keyboard users keep the ↑/↓ buttons.

export interface SortableOpts {
  /** Selector of the draggable items inside the container; each needs data-id. */
  item: string;
  /** Selector of the grip inside an item (drag starts only there). */
  handle: string;
  /** Called with the new id order after a drop that changed it. */
  onDrop: (ids: number[]) => void;
}

export function sortable(container: HTMLElement, opts: SortableOpts) {
  let drag: { el: HTMLElement; ph: HTMLElement; dy: number; startY: number; started: boolean; pointer: number; before: string } | null = null;

  const items = () => [...container.querySelectorAll<HTMLElement>(opts.item)];
  const order = () => items().map(i => Number(i.dataset.id));

  function start(e: PointerEvent) {
    const h = (e.target as HTMLElement).closest<HTMLElement>(opts.handle);
    if (!h || !container.contains(h) || e.button > 0) return;
    const el = h.closest<HTMLElement>(opts.item);
    if (!el) return;
    e.preventDefault();
    drag = { el, ph: el, dy: 0, startY: e.clientY, started: false, pointer: e.pointerId, before: order().join(",") };
    h.setPointerCapture?.(e.pointerId);
  }

  function begin() {
    if (!drag) return;
    const { el } = drag;
    const r = el.getBoundingClientRect();
    const ph = document.createElement("div");
    ph.className = "sort-ph";
    ph.style.height = `${r.height}px`;
    el.after(ph);
    drag.ph = ph;
    drag.dy = drag.startY - r.top;
    el.classList.add("sort-lift");
    Object.assign(el.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, zIndex: "80", pointerEvents: "none" });
    document.body.classList.add("sorting");
    drag.started = true;
  }

  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointer) return;
    if (!drag.started) { if (Math.abs(e.clientY - drag.startY) < 5) return; begin(); }
    e.preventDefault();
    drag.el.style.top = `${e.clientY - drag.dy}px`;
    // Move the placeholder before the first sibling whose midpoint is below the pointer.
    const sibs = items().filter(i => i !== drag!.el);
    const next = sibs.find(s => { const b = s.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
    if (next) { if (drag.ph.nextElementSibling !== next) next.before(drag.ph); }
    else { const last = sibs[sibs.length - 1]; if (last && last.nextElementSibling !== drag.ph) last.after(drag.ph); }
    // Edge auto-scroll for long lists: the list itself when it scrolls, otherwise the page.
    const box = drag.ph.parentElement;
    if (box && box.scrollHeight > box.clientHeight + 2) {
      const r = box.getBoundingClientRect();
      if (e.clientY < r.top + 40) box.scrollTop -= 12; else if (e.clientY > r.bottom - 40) box.scrollTop += 12;
    } else if (e.clientY < 70) scrollBy(0, -12); else if (e.clientY > innerHeight - 70) scrollBy(0, 12);
  }

  function end(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointer) return;
    const d = drag;
    drag = null;
    if (!d.started) return;
    d.ph.replaceWith(d.el);
    d.el.classList.remove("sort-lift");
    Object.assign(d.el.style, { position: "", left: "", top: "", width: "", zIndex: "", pointerEvents: "" });
    document.body.classList.remove("sorting");
    d.el.animate([{ transform: "scale(1.02)" }, { transform: "none" }], { duration: 200, easing: "ease-out" });
    // The pointerup also fires a click on the grip's button: swallow it so a drag never "selects" the item.
    const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
    container.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => container.removeEventListener("click", swallow, { capture: true }), 0);
    const ids = order();
    if (ids.join(",") !== d.before) opts.onDrop(ids);
  }

  container.addEventListener("pointerdown", start);
  addEventListener("pointermove", move, { passive: false });
  addEventListener("pointerup", end);
  addEventListener("pointercancel", end);
  return { get dragging() { return !!drag?.started; } };
}
