// v4: one coordinator navigation for every panel page. The phone tab bar keeps five entries (the projector screens open
// from the header on wider screens and from the Səhnə tab of the live panel).
export type AdminPage = "panel" | "setup" | "programs" | "qr" | "pult";
export function adminNav(current: AdminPage) {
  return [
    { href: "/admin", label: "Canlı panel", short: "Panel", icon: "users", current: current === "panel" },
    { href: "/admin/setup", label: "Quraşdırma", short: "Ayarlar", icon: "pencil", current: current === "setup" },
    { href: "/admin/programs", label: "Proqramlar", short: "Proqram", icon: "db", current: current === "programs" },
    { href: "/admin/qr", label: "QR kodlar", short: "QR", icon: "qr", current: current === "qr" },
    { href: "/admin/pult", label: "Pult", icon: "timer", current: current === "pult" },
    { href: "/stage", label: "Səhnə", icon: "expand", external: true, tab: false },
    { href: "/reveal", label: "Nəticə açıqlaması", short: "Nəticə", icon: "medal", external: true, tab: false },
  ];
}
