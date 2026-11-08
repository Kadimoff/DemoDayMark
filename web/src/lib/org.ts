// orgs: which organisation a page belongs to, and that organisation's public links.
//  - public screens: /o/<slug>/timer · /o/<slug>/stage · /o/<slug>/reveal · /o/<slug>/speaker · /o/<slug>/team, or ?org=<slug>;
//    the bare /timer, /reveal… keep showing the default organisation (old projector links keep working)
//  - coordinator pages: the organisation of the session (set from /api/auth/me by the top bar)
const ORG_PAGES = ["stage", "timer", "reveal", "speaker", "team"];

/** Slug named by the page URL, or null (= default organisation). */
export function pageOrg(): string | null {
  const m = location.pathname.match(/^\/o\/([a-z0-9-]{1,40})\//i);
  if (m) return m[1].toLowerCase();
  const q = new URLSearchParams(location.search).get("org");
  return q && /^[a-z0-9-]{1,40}$/i.test(q) ? q.toLowerCase() : null;
}

let panelSlug: string | null = null;
/** "/reveal" → "/o/<slug>/reveal" for a customer organisation; unchanged for the default one. */
export function orgPath(p: string, slug: string | null = panelSlug ?? pageOrg()): string {
  if (!slug || slug === "root") return p;
  const m = p.match(/^\/(stage|timer|reveal|speaker|team)(\/demo)?(\?.*)?$/);
  if (!m || m[2]) return p; // /stage/demo needs no organisation
  return `/o/${slug}/${m[1]}${m[3] ?? ""}`;
}

const isOrgLink = (href: string) => ORG_PAGES.some(p => href === `/${p}` || href.startsWith(`/${p}?`));

/** Rewrites projector links (<a href="/reveal">/reveal</a>) in `root` to the organisation's own (not `data-raw` ones). */
function fixLinks(root: ParentNode) {
  if (!panelSlug || panelSlug === "root") return;
  root.querySelectorAll<HTMLAnchorElement>("a[href^='/']:not([data-raw])").forEach(a => {
    const href = a.getAttribute("href")!;
    if (!isOrgLink(href)) return;
    const to = orgPath(href);
    if (a.textContent?.trim() === href) a.textContent = to;
    a.setAttribute("href", to);
  });
}

let observer: MutationObserver | null = null;
/** Coordinator pages: from now on every projector link on the page points at this organisation. */
export function setPanelOrg(slug: string) {
  panelSlug = slug;
  fixLinks(document);
  if (!observer && slug !== "root") {
    observer = new MutationObserver(ms => { for (const m of ms) m.addedNodes.forEach(n => { if (n instanceof Element) fixLinks(n.parentNode ?? n); }); });
    observer.observe(document.body, { childList: true, subtree: true });
  }
}
export const panelOrg = () => panelSlug;
