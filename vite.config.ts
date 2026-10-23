import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
    // Lets the page be opened through `tailscale serve` (https://<pc>.<tailnet>.ts.net)
    // from a phone. Vite refuses unknown Host headers to stop DNS rebinding;
    // tailnet names are ours, so they are let through and nothing else is.
    allowedHosts: ['.ts.net'],
    // IPv4 loopback, stated: on Windows `localhost` can resolve to ::1 alone,
    // and `tailscale serve http://127.0.0.1:5173` would then find nothing.
    host: '127.0.0.1',
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
})
