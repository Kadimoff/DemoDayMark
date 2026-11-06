// Juror reminders as system notifications (needs HTTPS; on plain HTTP the page never registers this).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const open = list.find(c => new URL(c.url).pathname === "/juror");
    return open ? open.focus() : self.clients.openWindow("/juror");
  }));
});
