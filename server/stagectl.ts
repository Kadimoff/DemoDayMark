// v3: one place that moves the slide on stage (coordinator panel, phone remote, projector clicker, and the team on stage).
import type { Repo } from "./repo.js";

export interface SlideMove { slide?: number; delta?: number }

/** Applies a slide change to the deck of the current scene (team presentation or event presentation), clamped to its pages. */
export function moveSlide(repo: Repo, b: SlideMove): boolean {
  if (b.slide === undefined && b.delta === undefined) return false;
  const ev = repo.getEvent();
  const show = repo.stage().show;
  const event = ev.stageScene === "event";
  const pages = event ? show.eventPres?.pages ?? null : show.pres?.pages ?? null;
  let slide = event ? ev.eventSlide : ev.stageSlide;
  const before = slide;
  if (b.slide !== undefined) slide = b.slide;
  if (b.delta !== undefined) slide += b.delta;
  slide = Math.max(1, pages ? Math.min(pages, slide) : slide);
  if (slide === before) return false;
  repo.updateEvent(event ? { eventSlide: slide } : { stageSlide: slide });
  return true;
}
