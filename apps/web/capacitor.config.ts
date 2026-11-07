import type { CapacitorConfig } from '@capacitor/cli';

// PRD §16 / Phase K — Capacitor wraps the same React build, no separate
// mobile codebase. `androidScheme: 'https'` matters here specifically:
// AuthService (§10.1) issues httpOnly Secure cookies, and Secure cookies
// are dropped on Android WebView's default `file://`/`capacitor://`
// origin. Serving the bundle from a synthetic `https://localhost` origin
// keeps the cookie flow identical to the web app — no separate token-auth
// path needed just for mobile.
const config: CapacitorConfig = {
  appId: 'com.abion.nexus',
  appName: 'NEXUS',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    // Debuggable webview during Phase K bring-up; flip off before any
    // Play Store submission build.
    webContentsDebuggingEnabled: true,
  },
};

export default config;
