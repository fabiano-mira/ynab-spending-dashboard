# YNAB Spending Dashboard
A personal, self-hosted spending dashboard for [YNAB](https://www.ynab.com/) — charts, a rule-based
spending advisor, raw transaction export, and a daily email digest. Runs as a single small Docker
container with zero npm dependencies (Node 18+ built-ins only).
Built by Fabiano Altheman Mira ([LinkedIn](https://www.linkedin.com/in/fabiano-mira/)).
## What this is
The active app lives entirely in [`report-app/`](./report-app) and is run via
[`docker-compose.yml`](./docker-compose.yml). It talks directly to the YNAB API using a
[Personal Access Token](https://api.ynab.com/#personal-access-tokens) (not OAuth), so it's meant to
run on a trusted host/network you control — it is **not** deployed publicly.
> **Note:** `src/`, `public/`, `webpack.config.js`, and `bin/` are leftover scaffolding from the
> original [YNAB API Starter Kit](https://github.com/ynab/ynab-api-starter-kit) template this repo
> was created from. They are unused by the real app and kept only for reference.
## Features
- **Dashboard** (`/`) — spending report over a configurable window (default 30 days): total spent,
  average per day, spend broken into rule-based buckets (Housing & Utilities, Subscriptions &
  Software, Food & Groceries, Gas & Auto, Health & Personal, People & Services, Investments &
  Crypto, Large One-Offs, Other), daily/weekly series, top categories and payees.
- **Charts** (`/charts`) — visualizes the same report data.
- **Advisor** (`/advisor`) — surfaces spending patterns worth a second look.
- **Raw export** (`/raw`, `/api/raw`, `/api/export.csv`) — every transaction, unfiltered, as JSON
  or a CSV download (Excel-friendly, UTF-8 BOM).
- **Daily email digest** — if SMTP is configured, a scheduled job (`scheduler.cjs`) emails a summary
  each day: yesterday's and last-7-days spend, top payees, spend by bucket, categories currently
  over budget, and subscriptions due in the next 3 days. Sent via a minimal built-in SMTP client
  (STARTTLS + AUTH LOGIN) — no mail library dependency.
- **`categorize.py`** — a standalone script (run manually, not part of the container) that
  auto-categorizes currently-uncategorized transactions using the same payee rules, with a
  `--dry-run` preview mode.
Transfers, balance adjustments, and credit-card/loan payments are automatically excluded from spend
totals so they aren't double-counted.
## Architecture
```
docker-compose.yml
└── ynab-report (report-app/Dockerfile, node:22-alpine)
    ├── server.cjs      HTTP server: serves the UI pages + /api/report, /api/raw, /api/export.csv
    ├── mailer.cjs       Builds and sends the daily digest email over raw SMTP
    ├── scheduler.cjs    Schedules mailer.cjs to run once daily at MAIL_HOUR
    ├── index.cjs        Docker entrypoint — starts server.cjs and scheduler.cjs together
    └── *.html           index / charts / advisor / raw front-ends (vanilla JS, no build step)
```
The container reads `../.env` (mounted via `env_file` in `docker-compose.yml`) for all
configuration — nothing is hardcoded, and `.env` is gitignored.
## Setup
1. Create a `.env` file in the repo root:
   ```
   YNAB_ACCESS_TOKEN=your-ynab-personal-access-token
   # optional — enables the daily email digest
   SMTP_HOST=smtp.example.com
   SMTP_PORT=587
   SMTP_USER=you@example.com
   SMTP_PASS=your-smtp-password
   MAIL_TO=you@example.com
   MAIL_HOUR=7
   ```
2. Start the container:
   ```zsh
   docker compose up -d
   ```
3. Open `http://<docker-host>:3333/` (maps to container port 3000).
If `SMTP_USER`/`SMTP_PASS`/`MAIL_TO` are not set, the daily digest is disabled and only the web
dashboard runs.
### Running the auto-categorizer
```zsh
YNAB_ACCESS_TOKEN=your-token python3 report-app/categorize.py --dry-run
```
Drop `--dry-run` to actually write category changes back to YNAB.
## Security notes
- `YNAB_ACCESS_TOKEN` grants full read/write access to your YNAB budget. Keep `.env` out of version
  control (already gitignored) and don't expose this container's port outside your trusted network.
- This app is not designed to be deployed as a public static site or behind a public reverse proxy
  without adding its own authentication — `server.cjs` has none.
## License
The original starter-kit scaffolding (`src/`, `public/`, `bin/`) remains under the Apache-2.0
license from [YNAB's starter kit](https://github.com/ynab/ynab-api-starter-kit) — see
[`LICENSE.md`](./LICENSE.md). `report-app/` is custom code written for this personal project.
