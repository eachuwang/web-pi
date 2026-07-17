# web-pi

Minimalist web UI + dashboard for [pi](https://pi.dev), built on the
`@earendil-works/pi-coding-agent` SDK. The webui server process owns the agent
session in-process (SDK-host, option A): one Node process runs Hono (HTTP + SSE)
and the React frontend talks to it.

## Dev

```bash
npm install
npm run dev
# web:  http://127.0.0.1:5173
# api:  http://127.0.0.1:3000
```

Reuses your `~/.pi/agent/auth.json` credentials (from `pi /login`); no re-auth.

Set `WEB_PI_CWD` to change the default agent working directory.

## Status

Milestone 1: project skeleton + end-to-end streaming (`text_delta`). Dashboard
panels, cwd picker, remaining routes (steer/followup/abort/model/compact/stats),
and prod static serving land next.
