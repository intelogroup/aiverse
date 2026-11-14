import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import './index.css'
import App from './App.tsx'
import { queryClient } from './lib/queryClient.ts'
import { persistOptions } from './lib/queryPersist.ts'
import { initTelemetry } from './lib/telemetry/index.ts'

// Telemetry Phase 1: black-box session log + env-gated error capture.
// Inert when VITE_SENTRY_DSN is unset; never blocks first render.
initTelemetry()

// Asset service worker (public/sw.js): cache-first + LRU for the R2-hosted
// world/body GLBs only — it never touches the app shell, HTML, or API.
// Production builds only; a failed registration is non-fatal (assets fall
// back to plain network loads).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <Suspense fallback={null}><App /></Suspense>
    </PersistQueryClientProvider>
  </StrictMode>,
)
