/* siiswell service worker: Web Push only. No fetch handler, nothing is cached. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Needs you";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/icon.svg",
    data: { url: typeof data.url === "string" ? data.url : "/" },
  };
  if (typeof data.tag === "string" && data.tag) {
    options.tag = data.tag; // one notification per alert key (host agent) or per source / relay sender (everything else)
    options.renotify = data.renotify === true; // only critical alerts buzz again when they replace a notification with the same tag
  }
  // iOS/Safari require every push to show a notification (userVisibleOnly).
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let target = new URL("/", self.location.origin);
  try {
    const wanted = new URL(event.notification.data && event.notification.data.url, self.location.origin);
    if (wanted.origin === self.location.origin) target = wanted; // never navigate off-site
  } catch {
    /* keep "/" */
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) {
        if (new URL(w.url).origin !== self.location.origin) continue;
        await w.focus();
        if ("navigate" in w) {
          try {
            await w.navigate(target.href);
          } catch {
            /* navigating an uncontrolled client can fail; focusing is enough */
          }
        }
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
