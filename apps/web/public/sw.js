// Increment this revision whenever a pre-cached shell asset changes.
const CACHE = "planee-shell-v4";
const SHELL = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const acceptsEvents = request.headers.get("accept")?.includes("text/event-stream");
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || acceptsEvents) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/index.html").then((cached) => cached ?? caches.match("/"))));
    return;
  }
  if (request.method !== "GET") return;

  event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
    if (response.ok && response.type === "basic" && !response.headers.get("content-type")?.includes("text/event-stream")) {
      void caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
    }
    return response;
  })));
});
const safeDeepLink = (value) => {
  if (typeof value !== "string") return "/";
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin) return "/";
    if (url.pathname === "/" || /^\/(sessions|actions|settings)(\/|$)/.test(url.pathname)) return `${url.pathname}${url.search}${url.hash}`;
  } catch { /* Use the safe default. */ }
  return "/";
};

self.addEventListener("push", (event) => {
  const data = event.data?.json();
  const path = safeDeepLink(data?.deepLink);
  event.waitUntil(self.registration.showNotification("Planee Agent Hub", {
    body: "A session update is available.",
    data: { path },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safeDeepLink(event.notification.data?.path);
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
    const existing = windows.find((windowClient) => new URL(windowClient.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      return existing.navigate(path);
    }
    return clients.openWindow(path);
  }));
});