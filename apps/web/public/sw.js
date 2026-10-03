/*
 * Oh-My-TUI service worker — deliberately cache-free.
 *
 * A fetch handler is present only so browsers that still require one for
 * home-screen installation accept the app. It never calls the Cache Storage API
 * and never synthesizes responses: every request goes to the network, and the
 * Server also sends `Cache-Control: no-store`. Authenticated APIs, terminal
 * streams, credentials, and enrollment data are therefore never cached.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // Intentionally empty: network-only, no caching.
});
