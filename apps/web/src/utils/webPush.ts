// Standard urlsafe-base64 -> Uint8Array conversion for
// PushManager.subscribe()'s applicationServerKey — the browser Push API
// wants raw bytes, VAPID_PUBLIC_KEY is generated/stored as urlsafe
// base64 (npx web-push generate-vapid-keys' own output format, per
// apps/api/.env.example). Same conversion every web-push tutorial uses;
// no library needed for one function.
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
