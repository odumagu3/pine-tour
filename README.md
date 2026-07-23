# Neon Whot! Bet (Pine Tour)

Real-time, multiplayer Whot tournament app.

- **Frontend:** React + Vite → deployed on Vercel
- **Backend:** Express + WebSocket game engine → deployed on Render
- **Data & Auth:** Supabase (Postgres + email/password auth)

## Run locally

**Prerequisites:** Node.js

1. Install dependencies:
   `npm install`
2. Copy `.env.example` to `.env.local` and fill in your Supabase values
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).
   Leave `VITE_API_URL` / `VITE_WS_URL` empty to run the all-in-one server on same origin.
3. Run the app (serves frontend + backend together):
   `npm run dev`

The app runs at http://localhost:5174.

## Build

`npm run build` — builds the Vite frontend into `dist/` and bundles the server to `dist/server.cjs`.
