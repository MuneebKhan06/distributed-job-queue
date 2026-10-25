# Job Queue Dashboard

A small React and TypeScript dashboard for the distributed job queue. It talks
to the FastAPI service over the same REST endpoints any other client uses:
nothing here reaches into Redis or PostgreSQL directly.

## Running it

Start the backend stack from the repository root first:

```bash
docker compose up -d
```

Then, from this directory:

```bash
npm install
npm run dev
```

The dashboard is served on http://localhost:5173. Requests to `/api/*` are
proxied to the API, so the browser stays on one origin and the API needs no
CORS configuration for local work.

If the API is not on port 8000, copy `.env.example` to `.env.local` and set
`VITE_API_TARGET`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload and the API proxy |
| `npm run build` | Type check, then produce static files in `dist/` |
| `npm run preview` | Serve the built files locally |
| `npm run typecheck` | Type check only |

## Layout

```
src/
|-- api/
|   |-- types.ts          # Mirrors app/schemas/jobs.py
|   |-- client.ts         # fetch wrapper and one function per endpoint
|-- components/           # Layout, badges, filters, pager, dialogs, replay
|-- hooks/                # Hash routing, polling, debounce, job statuses
|-- lib/                  # Formatting, presets, submission checks, metrics parser
|-- pages/                # Overview, jobs, job detail, submit, DLQ
|-- styles.css            # Theme variables, light and dark
```
