import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initTelemetry } from './lib/telemetry/index.ts'

// Telemetry Phase 1: black-box session log + env-gated error capture.
// Inert when VITE_SENTRY_DSN is unset; never blocks first render.
initTelemetry()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
