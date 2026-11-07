// Registers sw.js (public/sw.js) and listens for the in-place navigation
// message it posts on notification click (PRD §15, §10.4).
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('SW registration failed:', err);
    });
  });

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'nexus-navigate' && event.data.url) {
      const target = new URL(event.data.url);
      window.history.pushState({}, '', target.pathname + target.search);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  });
}
