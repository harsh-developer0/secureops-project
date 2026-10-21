# SecureOps – Secure DevOps Pipeline with Monitoring and Rollback

SecureOps is a **local, educational** web application that demonstrates a Secure DevOps workflow:
a release pipeline with a security gate, versioned deployments, real HTTP health monitoring,
incident tracking, and rollback to a previous working version.

It needs only **Node.js** – no Docker, Jenkins, Kubernetes, cloud account or internet access at runtime.

| App | URL | Purpose |
|---|---|---|
| SecureOps dashboard | http://localhost:3000 | Control panel (pipeline, security, deploy, monitor, rollback) |
| Sample shopping app | http://localhost:4000 | The application that SecureOps deploys and monitors |

## What is real and what is simulated

**Real (runs locally):** file/config validation, automated tests against a temporary copy of the shop,
the security scan (secret patterns, unsafe config, HTTP headers, `.gitignore`), the release gate,
versioned release manifests in `releases/`, deployments (change what the shop serves),
HTTP health probes with measured response time, incidents, rollbacks, and persistent history.

**Simulated:** only the *injected failure* (`Simulate Failure` sets a flag so the shop's `/health`
endpoint returns 503). The dashboard labels it **SIMULATED** everywhere. Nothing is damaged or killed.

**Not claimed:** no GitHub Actions / cloud connection exists. The security checks are basic
and are **not** a comprehensive audit; `npm audit` is shown as "not run" because it needs internet access.

## 1. Prerequisites (Windows)

1. Install **Node.js 18 or newer** (LTS recommended) from https://nodejs.org (accept the defaults).
2. Open **PowerShell** and verify:
   ```powershell
   node -v
   npm -v
   ```
   Both must print a version number (Node `v18.x` or higher).

## 2. Install dependencies

Extract the ZIP, then in PowerShell:
```powershell
cd path\to\secureops-project
npm install
```
Only one dependency is installed (`express`). Data is stored in a simple JSON file (`data\secureops-db.json`),
so there is no native SQLite build step that could fail on Windows.

## 3. Start the project

```powershell
npm start
```
You should see:
```
SecureOps is running.
  Dashboard : http://127.0.0.1:3000
  Shop app  : http://127.0.0.1:4000
Press Ctrl+C to stop.
```

## 4. URLs to open

- Dashboard: http://localhost:3000
- Live shopping app: http://localhost:4000 (or click **View Live App** on the dashboard)

## 5. Stop the application

Click into the PowerShell window and press **Ctrl+C**. Both servers shut down cleanly.
(Data is kept in `data\secureops-db.json` and is still there on the next start.)

## 6. Run the automated tests

```powershell
npm test
```
Tests use temporary databases and random free ports, so they work even while the app is running.
They cover API routes and validation, pipeline stages and the release gate, deployment, health checks,
incidents, rollback (including a failing rollback), overlapping-operation protection, persistence, reset and the cart logic.

## 7. Full demonstration (all from the browser)

Open http://localhost:3000. The demo starts with baseline version **0.9.0** active.

1. Select **1.0.0** in *Release version* and click **Run Pipeline**. Watch the 5 stages (validate, tests, security, release gate, record); open the logs under the stages.
2. Click **Deploy** (enabled for any version; it succeeds only because the gate passed). The *Active version* card changes to 1.0.0.
3. Click **Check Health** → **Healthy** with a measured response time.
4. Click **Simulate Failure** (labelled SIMULATED).
5. Click **Check Health** → **Unhealthy**; an incident appears under *Incidents & alerts*.
6. Click **Rollback** → the previous version (0.9.0) is restored, the failure flag is cleared, a health check verifies recovery, and the incident is marked resolved. The history table shows the rollback.
7. Click **Check Health** again → **Healthy**.
8. Click **View Live App** → the shopping app (version 0.9.0) opens; add products to the cart.

**Bonus – see the release gate block a bad release:** select **1.2.0** and click **Run Pipeline**.
It fails the security stage (a deliberately placed *fake* demo key and debug mode in `releases/1.2.0.json`),
and **Deploy** is then refused by the server. The fake value is redacted in all output.

**Reset:** click **Reset Demo** (bottom of the page) and confirm. All history is cleared and 0.9.0 is active again.

## 8. Troubleshooting

| Problem | Fix |
|---|---|
| `Port 3000 is already in use` (or 4000) | Another program uses the port. Close it, or use other ports: `$env:DASHBOARD_PORT=3001; $env:SHOP_PORT=4001; npm start` then open the URL printed. |
| Find what uses a port | `netstat -ano \| findstr :3000` then `taskkill /PID <pid> /F` |
| `'npm' is not recognized` | Reinstall Node.js, then open a **new** PowerShell window. |
| `npm : File ...npm.ps1 cannot be loaded because running scripts is disabled` | Run once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `npm.cmd start`. |
| Dashboard shows "Backend disconnected" | The server stopped. Run `npm start` again. |
| `Cannot find module 'express'` | Run `npm install` inside the `secureops-project` folder. |
| Node version too old | Run `node -v`; install Node 18+. |
| Want a totally fresh start | Stop the app, delete the `data` folder, start again (or use **Reset Demo**). |

## Project layout

```
server.js                 entry point (npm start)
src/app.js                dashboard API routes + starts both servers
src/pipeline.js           the 5-stage pipeline and release gate
src/security.js           local security checks
src/ops.js                health checks, incidents, deploy, rollback, failure simulation, reset
src/store.js              persistent JSON store (atomic writes)
src/releases.js           release manifest loading/validation
src/shop/                 sample shopping app (server + cart logic)
public/dashboard/         dashboard UI (HTML/CSS/JS, no build step)
public/shop/              shopping UI
releases/                 versioned release manifests (0.9.0, 1.0.0, 1.1.0, 1.2.0)
tests/                    automated tests (node:test)
```

## How it works (short)

- The shop reads the **active release manifest** (`releases/<version>.json`) on every request, so deploying or rolling back really changes what it serves.
- Deploy pushes the current version onto a stack; **Rollback** pops it, re-validates that release, switches back, clears the injected failure, and runs a fresh health probe. If any step fails, the error is reported and the previous state is kept.
- Deploy / rollback / pipeline / health actions share a lock, so overlapping clicks cannot corrupt state (the second request gets a clear "operation in progress" error).
- The dashboard binds to `127.0.0.1` only and rejects cross-origin POSTs.
