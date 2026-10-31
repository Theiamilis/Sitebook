# Sitebook app source

An anonymized Node.js application for daily field documentation. It includes a small Express-free HTTP server, SQLite storage, user login, photo and video uploads, editable reports, and optional Discord forum sync.

## Run locally

- Install Node.js 22.16 or newer.
- In this folder run `npm install`, then `npm start`.
- Open `http://127.0.0.1:4173` and create the first admin account. The server binds to localhost by default.
- Set the project name and Week 1 start date in Settings. Add a Discord forum webhook there if you want synchronization.

The app creates its private runtime files in `app/data` and stores its webhook separately in `app/.env.local`. These files are intentionally excluded from this repository. Back up runtime data separately and never commit real photos, videos, report exports, database files, accounts, or webhook URLs.

## Scope

This is source code for review and local use. The repository's root page is a static portfolio preview; it does not connect to or host a running backend. The original field archive and its documents are not included.
