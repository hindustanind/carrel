# Carrel: live seat finder for the LPU Central Library

Code Fuzion 2026 · Problem **M4 Smart Library Seat Finder**.

Students see every free seat across three reading floors, live. They hold a seat for 10 minutes, check in with the signed QR code on the desk, and step away for up to 20 minutes. A seat left with a bag goes back to everyone automatically. Librarians get peak hours and the seats that are always hogged.

| M4 requirement | How Carrel meets it | Proof |
|---|---|---|
| Live floor map, under 5 s | Postgres `NOTIFY` on every booking change → Server-Sent Events → every open screen. Falls back to 3 s polling if the stream drops. | `tests/api.test.js` (stream delivers in about 100 ms), e2e "another student sees the seat taken within 5 seconds", admin shows measured p95 |
| QR check-in at the seat | Desk QR = `/s/<seat>?k=<HMAC>`. Edited or forged codes fail. Check-in only works for the student holding that seat (or a walk-up to a free desk). | API tests on forged codes, other-desk codes, non-holders and walk-ups; e2e journey |
| 20-min break + auto-release | Timers are `expires_at` timestamps in Postgres. A sweeper releases expired holds and breaks every 5 s, and every booking call also releases stale rows first. | API tests on hold expiry, break expiry, resume and time scale; e2e auto-release |
| No double bookings under load | Partial unique indexes (one live booking per seat, one per student) plus one transaction per action. | 300-way race test; `scripts/loadtest.js` (500 students, 1 winner) |
| Admin: peak hours, hogged seats | Append-only `seat_events` log → hour × weekday heatmap (IST) and a 7-day hog score. | API admin test; e2e admin |

## Run it locally

Needs Node 20+ and Docker.

```bash
docker run -d --name carrel-pg -e POSTGRES_USER=carrel -e POSTGRES_PASSWORD=carrel -e POSTGRES_DB=carrel -p 5544:5432 postgres:16-alpine
cp .env.example .env
npm install
npm run build && npm start        # http://localhost:8080 (migrates + seeds 3 floors × 129 seats on boot)
```

Demo accounts (seeded outside production, or with `SEED_DEMO=1`):

| Role | Registration no. | Password |
|---|---|---|
| Admin | 12300001 | admin-demo-2026 |
| Student | 12300002 | student-demo-2026 |
| Judges | 12300003 / 12300004 | judge-demo-2026 |

Pages: `/` story · `/app` seat finder · `/admin` librarian dashboard · `/desk` live desk-QR demo (admin) · `/api/admin/qr?floor=1` printable desk QR codes.

**Live QR demo with a real phone:** open `/desk` on the laptop (admin login) and pick a seat. Scan the QR with any phone on the same Wi-Fi; it opens Carrel, the student logs in, and the laptop flips that seat to *Taken* within a second. In development the desk QR uses the laptop's Wi-Fi address automatically; in production it uses `PUBLIC_ORIGIN`. `node scripts/desk-demo-check.js` runs the same flow with a laptop and an emulated iPhone.

## Tests

```bash
npm test                 # 14 API tests against real PostgreSQL (creates a throwaway carrel_test database)
npm run test:e2e         # 7 browser tests in Chrome (fresh carrel_e2e database, 60× time scale)
npm run loadtest -- http://localhost:8080 500   # judges: 500 students race for one seat → exactly one wins
```

## Deploy (the only step left)

Any host that runs a Docker container with a PostgreSQL 14+ database, for example Render, Railway, Fly.io or a VPS. The server keeps an SSE stream and a Postgres `LISTEN` connection open, so use a long-running container rather than serverless functions.

1. Create a managed PostgreSQL database and copy its `DATABASE_URL`.
2. Deploy this repo with the included `Dockerfile`.
3. Set environment variables:
   - `DATABASE_URL`
   - `SESSION_SECRET` and `QR_SECRET`: long random strings, e.g. `openssl rand -base64 48`
   - `PUBLIC_ORIGIN`: your real URL; it is printed into every desk QR
   - `NODE_ENV=production`
   - `SEED_DEMO=1` (only if you want the demo accounts for judging)
4. Open `/api/health`, then print the desk QR sheets from `/admin`.

A production-like local stack is also available: `docker compose up --build`.

The server refuses to start in production with the development secrets.

## How it is built

- **Database (`db/schema.sql`)**: every rule lives in SQL functions (`book_seat`, `check_in`, `start_break`, `end_session`, `release_expired`, `admin_release`). The partial unique indexes are the fairness guarantee.
- **Server (`server/`)**: plain `node:http`, `pg`, scrypt passwords, HMAC-signed sessions and desk codes, JSON-only POSTs (blocks cross-site form posts), and login rate limiting.
- **Frontend (`web/`)**: built with Vite, no framework.
  - The story page is five chapters. One scroll, swipe, arrow key or "Next" click plays a smooth camera move (a 230-frame flight rendered in Blender) to the next chapter.
  - The seat finder overlays live seat pins on photoreal interior renders, using the same camera projection as Blender.
  - "View from seat" opens a real eye-level render from that exact chair (camera at 1.2 m, facing the desk), one for each of the 129 seat positions.
  - A 2D plan view is available for accessibility and slow phones.
- **3D (`../blender/`)**: the reading floor is procedurally modelled from public photos of the LPU Central Library (Block 37) and rendered in Cycles.

## AI use (declared)

- **Claude (Opus 5.5):** architecture, SQL, server, frontend, tests.
- **Gemini 4 Neon (Antigravity) and Codex:** Blender scene detailing passes.

All rules and code were reviewed and are explained by the team.

## Known limits

- Someone could photograph a desk QR. Check-in still requires holding that exact seat, and holds without check-in raise the hog score. A next step would be campus Wi-Fi or geofence checks at check-in.
- The floor layout is modelled from public photos. Seat counts are an assumption until the library confirms them.
- The three floors share one layout, so "View from seat" uses one render per seat position (129 renders), not per floor.
