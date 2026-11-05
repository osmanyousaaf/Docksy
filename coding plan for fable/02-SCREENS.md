# Docksy screens, A to Z

Every screen, every section on it, every button, every API call it makes, and the checks it must pass before the user says OK.
Generated from the interactive plan (https://claude.ai/artifact/8zhYEMfMV2fF9MifcHheJF). **S** = screen number, **I** = issue, **D** = decision.

Status legend: `draft` First draft · `fix` First draft · has an issue · `review` Built · waiting for your OK · `ok` Approved · `none` Not started

## Build order

Build one screen at a time, in this order. Each screen: build → screenshot next to the Coolify reference → click every button on the demo → the-user agent reviews → fix → team lead marks it approved.

### 1 · Frame first

| Screen | What |
|---|---|
| S1 Sidebar | Sidebar and page shell: menu, header, tabs, loading, empty and error states |
| S2 Login | Login |
| S3 First-time setup | First-time setup |
| S4 Overview | Overview |

### 2 · Servers

| Screen | What |
|---|---|
| S5 Servers list | Servers list |
| S6 Add server | Add server wizard, tested against the fake VPS |
| S7 Server detail | Server detail: Overview tab with live metrics |
| S7 › Containers | Server detail: Containers, Configuration and Danger Zone tabs |
| Diagnose panel | Diagnose panel |

### 3 · Apps

| Screen | What |
|---|---|
| S8 Apps list | Apps list |
| S9 New resource | New resource, tested once each with git, image and Postgres |
| S10 › General | Configuration: General |
| S10 › Source | Configuration: Source |
| S10 › Environment Variables | Configuration: Environment Variables |
| S10 › Persistent Storage | Configuration: Persistent Storage |
| S10 › Health Check | Configuration: Health Check |
| S10 › Resource Limits | Configuration: Resource Limits |
| S10 › Webhooks | Configuration: Webhooks |
| S10 › Backups | Configuration: Backups |
| S10 › Danger Zone | Configuration: Danger Zone |
| S11 Deployments | Deployments tab |
| S12 Logs | Logs tab |
| S13 Terminal | Terminal tab |
| S14 Metrics | Metrics tab |
| S15 Deployment log | Deployment log |

### 4 · Monitoring, settings, public

| Screen | What |
|---|---|
| S16 Alerts | Alerts, with I1 and I2 fixed |
| S17 Uptime | Uptime |
| S18 Settings | Settings |
| S19 Claude setup | Claude setup |
| S20 Status page | Public status page |
| S21 Not found | Not found |
| final | Final pass: click through every screen, check phone width, run the full fake-VPS test |

## Screens

### S1 — every page — Sidebar

- **Where:** `all logged-in pages`
- **Kind:** The frame around every page
- **Status:** Built · waiting for your OK

The frame around every logged-in page: the sidebar, the page header with breadcrumbs and tabs, and the loading, empty and error states. It is built first because every other screen sits inside it.

**On the screen**
- Logo, the word Docksy and the version (v0.1.0, read from the server)
- Search box with a ⌘K hint; opens a quick switcher to any server, app or page
- Menu in this order, gray icon and word: Overview, Servers, Apps, Alerts, Uptime, Claude, Settings
- Active item: #1a1a1a background, white text; others gray, white on hover
- Alerts shows a small red number while alerts are firing; nothing when zero
- Bottom: user name and email, then Logout
- Under 768px the sidebar hides; a top bar shows menu, logo, search and alerts, and the menu opens the same sidebar as a drawer

**Buttons**
- `Search`
- `Logout`

**Talks to the server**
- `GET /auth/me`
- `GET /health`
- `GET /alerts?state=firing (every 30s)`

**Checks before the user's OK**
- [ ] Active item matches the URL on every page, including deep links
- [ ] Red count on Alerts goes away when the last alert resolves
- [ ] Drawer closes after a tap on a menu item on a phone
- [ ] Loading shows a spinner, never a blank page
- [ ] Error shows the server's message and a Retry button

### S2 — /login — Login

- **Where:** `/login`
- **Kind:** Screen · no login
- **Status:** First draft

Sign in. A centered 360px column on the black page, no sidebar.

**On the screen**
- Logo and Docksy, title Sign in, one gray line
- Email and Password fields
- Wrong password: red line under the button, the email stays filled
- Too many tries: a line saying to wait a minute
- After sign-in: the page the user wanted (?next=), else Overview

**Buttons**
- `Sign in`

**Talks to the server**
- `POST /auth/login`

**Checks before the user's OK**
- [ ] Enter submits the form
- [ ] Error text shows under the button and keeps the email
- [ ] Looks right at 390px wide

**Linked to**
- → S4 Overview (after sign-in)
- ← S3 First-time setup (after the owner is created)

### S3 — /setup — First-time setup

- **Where:** `/setup`
- **Kind:** Screen · no login
- **Status:** First draft

Create the owner account on a fresh install. Shown only when no user exists yet.

**On the screen**
- Same centered layout as Login; title Create your account
- Name, Email, Password (minimum 10 characters, shown under the field), Confirm password
- Then Overview with its empty state

**Buttons**
- `Create account`

**Talks to the server**
- `GET /auth/state`
- `POST /auth/setup`

**Checks before the user's OK**
- [ ] Password rule shown before submit, not only after
- [ ] Visiting /setup after setup redirects to /login

**Linked to**
- → S2 Login (after the owner is created)

### S4 — / — Overview

- **Where:** `/`
- **Kind:** Screen
- **Status:** First draft

The whole system at a glance. The first page after sign-in.

**On the screen**
- Header: Overview, one line, + Add server on the right
- Five number tiles: Servers, Online (1 / 1), Apps, Running containers, Firing alerts (red when above 0)
- Servers table: name and IP, status, CPU % with a thin bar, Memory % with bar and GB, Disk % with bar and GB, CPU trend (small gray line, last 5 minutes), Apps count; a row click opens the server; refreshes every 10 seconds
- Two columns: Firing alerts (severity dot, title, server, how long) and Recent deployments (app, status, time, duration), each with an All link
- Empty state when there is no server: Add your first server, with three short steps

**Buttons**
- `+ Add server`
- `All alerts`
- `All apps`

**Talks to the server**
- `GET /overview`
- `GET /alerts?state=firing`
- `GET /deployments?limit=5`

**Checks before the user's OK**
- [ ] Numbers match the server page
- [ ] Empty state checked on a fresh install
- [ ] Bars turn yellow at 75% and red at 90%, gray otherwise

**Linked to**
- → S7 Server detail (a server row on Overview opens the server)
- ← Overview (opens)
- ← S2 Login (after sign-in)

### S5 — /servers — Servers list

- **Where:** `/servers`
- **Kind:** Screen
- **Status:** First draft

All servers in one table.

**On the screen**
- Header: Servers, one line, + Add server
- Table: Name, Host (user@ip:port), Status (Online, Offline, Not set up), OS, CPU cores, RAM, Agent version, Last seen; a row click opens the server
- Empty state with the Add server button

**Buttons**
- `+ Add server`

**Talks to the server**
- `GET /servers`

**Checks before the user's OK**
- [ ] Offline servers show red status and 'last seen 5m ago'
- [ ] A server still being set up shows yellow Provisioning

**Linked to**
- → S6 Add server (+ Add server)
- → S7 Server detail (a row click opens the server)
- ← Servers (opens)

### S6 — /servers/new — Add server

- **Where:** `/servers/new`
- **Kind:** Screen
- **Status:** First draft

Connect a new VPS in three steps, with a step bar on top: 1 Connect → 2 Check → 3 Install.

**On the screen**
- Connect: Name, IP or hostname, SSH port (22), SSH user (root); a box with Docksy's public key and a one-line command to add it, both with Copy
- Check: runs the check and lists five results with a green or red dot: SSH login, root or sudo, OS, Docker, free disk; red items show the fix in one line
- Install: a live log in a black terminal box and a step list (Install Docker → Create network → Start proxy → Install agent); on success 'Server is ready' and Open server

**Buttons**
- `Continue`
- `Re-check`
- `Install Docksy on this server`
- `Open server`
- `Copy`

**Talks to the server**
- `GET /ssh-key`
- `POST /servers`
- `POST /servers/:id/validate`
- `POST /servers/:id/provision`
- `stream /servers/:id/provision/stream`

**Checks before the user's OK**
- [ ] Copy buttons work
- [ ] Leaving during install and coming back shows the log so far
- [ ] A failed install shows the error and a Retry button
- [ ] Continue is disabled until SSH works

**Linked to**
- → S7 Server detail (Open server, when installed)
- ← S5 Servers list (+ Add server)

### S7 — /servers/:id — Server detail

- **Where:** `/servers/:id`
- **Kind:** Screen
- **Status:** First draft

One server. Breadcrumbs Servers › e2e-vps, ● Online, a gray line with user@ip:port, OS, cores, RAM, agent version and 'updated 2s ago'. Four tabs, a Diagnose button and the time range on the right.

**On the screen**
- Tabs: Overview, Containers, Configuration, Danger Zone
- Right side: Diagnose, and the range 15m 1h 6h 24h 7d 30d
- Live: numbers update every 5 to 10 seconds without a reload
- No data yet: 'The agent has not reported yet' with three troubleshooting steps and Re-install agent

**Buttons**
- `Diagnose`
- `Range picker`

**Talks to the server**
- `GET /servers/:id`
- `GET /servers/:id/metrics?range=`
- `stream /servers/:id/metrics/live`
- `GET /diagnose?serverId=`

**Checks before the user's OK**
- [ ] Range switch reloads charts in under 1 second
- [ ] The live dot goes gray when nothing arrives for 30 seconds

**Linked to**
- ← S6 Add server (Open server, when installed)
- ← S5 Servers list (a row click opens the server)
- ← S4 Overview (a server row on Overview opens the server)

#### Tabs on Server detail

##### metrics Overview

- **Where:** `/servers/:id` · **Status:** First draft

The metrics tab. Plain numbers and thin bars, monochrome charts. No glowing gauges.

**On the screen**
- Four tiles: CPU %, Memory %, Disk %, Load (1m); each a big number, a thin bar and a gray line (12 cores · 1.4 GB of 8 GB · 26 GB of 916 GB · 5m 0.45 / 15m 0.42)
- Per-core strip: one small square per CPU core; darker gray idle, white busy, red at 90%+
- History in a 2 × 2 grid: CPU with a dashed 'alert 90%' line, Memory used vs total, Network in and out, Disk

**Buttons**
- none

**Talks to the server**
- `GET /servers/:id/metrics?range=`
- `stream /servers/:id/metrics/live`

**Checks**
- [ ] Per-core strip shows the right number of cores
- [ ] Charts keep the same gray style on every page

##### Containers

- **Where:** `/servers/:id?tab=containers` · **Status:** First draft

Every container on the server.

**On the screen**
- Table: name, app (link), image, state dot, CPU % bar, memory bar, restarts, uptime

**Buttons**
- none

**Talks to the server**
- `GET /servers/:id/containers`

**Checks**
- [ ] Containers not managed by Docksy still appear, with no app link

##### Configuration

- **Where:** `/servers/:id?tab=configuration` · **Status:** First draft

The server's own settings.

**On the screen**
- Form: Name, Host, Port, SSH user, with Save
- Read-only facts: OS, arch, cores, RAM, disk, agent version

**Buttons**
- `Save`
- `Check connection`
- `Re-install agent`

**Talks to the server**
- `PATCH /servers/:id`
- `POST /servers/:id/validate`
- `POST /servers/:id/provision`

**Checks**
- [ ] Save sends only changed fields and shows Saved

##### Danger Zone

- **Where:** `/servers/:id?tab=danger` · **Status:** First draft

Delete the server.

**On the screen**
- Delete server, with the server name typed to confirm
- Blocked with a clear message while apps still run on it

**Buttons**
- `Delete server`

**Talks to the server**
- `DELETE /servers/:id`

**Checks**
- [ ] Delete is blocked while apps exist

### Containers

- **Where:** `/servers/:id?tab=containers`
- **Kind:** Tab inside a screen
- **Status:** First draft

Every container on the server.

**On the screen**
- Table: name, app (link), image, state dot, CPU % bar, memory bar, restarts, uptime

**Buttons**
- none

**Talks to the server**
- `GET /servers/:id/containers`

**Checks before the user's OK**
- [ ] Containers not managed by Docksy still appear, with no app link

### Diagnose panel

- **Where:** `opens on the right`
- **Kind:** Panel
- **Status:** First draft

What Claude reads. Opens on the right of the server page.

**On the screen**
- One-line verdict
- Findings sorted by severity: dot and title, the numbers behind it, the suggested fix
- Copy for Claude: /docksy:diagnose e2e-vps

**Buttons**
- `Diagnose`
- `Copy for Claude`

**Talks to the server**
- `GET /diagnose?serverId=`

**Checks before the user's OK**
- [ ] A healthy server says so in one line, with no empty list

**Linked to**
- ← S16 Alerts (an alert names /docksy:diagnose <server>)

### S8 — /apps — Apps list

- **Where:** `/apps`
- **Kind:** Screen
- **Status:** First draft

All apps in one table.

**On the screen**
- Header: Apps, one line, + New (white)
- Search box and a Server filter
- Table: Name with the description in gray under it, Status, Type (Git · Dockerfile, Image, Postgres template), Server, Domain (link), Last deploy ('5h ago', links to that deployment), a Redeploy button
- Empty state: No apps yet, with the New button

**Buttons**
- `+ New`
- `Redeploy`

**Talks to the server**
- `GET /apps`
- `GET /servers`
- `POST /apps/:id/deploy`

**Checks before the user's OK**
- [ ] Search filters as you type
- [ ] Redeploy asks nothing and shows Deploying right away

**Linked to**
- → S9 New resource (+ New)
- → S10 Configuration (a row click opens the app)
- → S15 Deployment log ('Last deploy' links to that deployment)
- ← Apps (opens)

### S9 — /apps/new — New resource

- **Where:** `/apps/new`
- **Kind:** Screen
- **Status:** First draft

Coolify's New Resource flow, simpler. Step 1 picks what to create; step 2 is one form for that choice.

**On the screen**
- Step 1, plain bordered rows in three groups, each with a gray icon, a name and one line. Applications: Public Git repository, Private Git repository, Docker image. Databases: PostgreSQL, MySQL, MariaDB, Redis, MongoDB. Services: n8n, Uptime Kuma, Umami, MinIO, Ghost, WordPress
- General: Name *, Description, Server *
- Source: Repository URL * and Branch * (git), Access token (private), or Image * (image)
- Build: Build pack (Auto-detect, Dockerfile, Docker Compose), Base directory, Dockerfile location, Custom start command, Watch paths
- Network: Port, Health check path, Domains with Generate Domain
- Environment variables: paste a .env
- Resource limits: CPU cores, Memory MB (empty = no limit)
- Auto-deploy on push checkbox
- Databases and services hide Source and Build; they show the template image and a masked generated password

**Buttons**
- `Create & Deploy`
- `Back`
- `Generate Domain`

**Talks to the server**
- `GET /templates`
- `GET /servers`
- `POST /apps`
- `POST /apps/:id/deploy`

**Checks before the user's OK**
- [ ] Name rule shown: lowercase letters, digits, dashes, 3 to 40 characters
- [ ] After Create the deployment log opens and streams
- [ ] Tested once for real with each of git, image and Postgres

**Linked to**
- → S15 Deployment log (Create & Deploy opens the live log)
- ← S8 Apps list (+ New)

### General

- **Where:** `/apps/:id?section=general`
- **Kind:** Configuration section
- **Status:** First draft

The main settings, like Coolify's General.

**On the screen**
- Name * (locked after the first deploy, with the reason), Description
- Build pack *, Port
- Domains, one per line, with Generate Domain (adds name.ip.sslip.io)
- Build: Base directory, Dockerfile location, Compose location (compose only), Custom start command, Watch paths (one glob per line; pushes deploy only when a changed file matches)
- Auto-deploy on push checkbox

**Buttons**
- `Save`
- `Generate Domain`

**Talks to the server**
- `PATCH /apps/:id`

**Checks before the user's OK**
- [ ] Generate Domain fills the box and Save keeps it
- [ ] Watch paths explained in one line under the field

### Source

- **Where:** `/apps/:id?section=source`
- **Kind:** Configuration section
- **Status:** First draft

Where the app comes from.

**On the screen**
- Git: repository URL, branch, token (shows 'set', with Replace and Remove)
- Image: image name and tag

**Buttons**
- `Save`
- `Replace token`
- `Remove token`

**Talks to the server**
- `PATCH /apps/:id`

**Checks before the user's OK**
- [ ] The token is never shown back after saving

### Environment Variables

- **Where:** `/apps/:id?section=env`
- **Kind:** Configuration section
- **Status:** First draft

Key and value pairs the app sees.

**On the screen**
- Table of key / value, Add row, Delete row
- Paste .env, Reveal values
- Values masked by default

**Buttons**
- `Save`
- `Add`
- `Paste .env`
- `Reveal`

**Talks to the server**
- `GET /apps/:id/env`
- `PUT /apps/:id/env`

**Checks before the user's OK**
- [ ] A masked value is never saved back over the real one
- [ ] Pasting a .env with quotes and comments parses correctly

### Persistent Storage

- **Where:** `/apps/:id?section=storage`
- **Kind:** Configuration section
- **Status:** First draft

Volumes that survive a redeploy.

**On the screen**
- List of volumes: name and mount path
- Add, Remove
- Note: applies on the next deploy

**Buttons**
- `Save`
- `Add volume`
- `Remove`

**Talks to the server**
- `PATCH /apps/:id`

**Checks before the user's OK**
- [ ] A mount path must start with /

### Health Check

- **Where:** `/apps/:id?section=health`
- **Kind:** Configuration section
- **Status:** First draft

How Docksy knows the new version is up before it removes the old one.

**On the screen**
- Path, for example /health
- Note: the new version must answer 2xx before the old one is removed

**Buttons**
- `Save`

**Talks to the server**
- `PATCH /apps/:id`

**Checks before the user's OK**
- [ ] Empty path means 'running for 5 seconds is enough', and the note says so

### Resource Limits

- **Where:** `/apps/:id?section=limits`
- **Kind:** Configuration section
- **Status:** First draft

Caps on CPU and memory.

**On the screen**
- CPU cores (for example 0.5), Memory MB (for example 512)
- Empty = no limit; applies on the next deploy

**Buttons**
- `Save`

**Talks to the server**
- `PATCH /apps/:id`

**Checks before the user's OK**
- [ ] Values below the minimum are refused with a clear message

### Webhooks

- **Where:** `/apps/:id?section=webhooks`
- **Kind:** Configuration section
- **Status:** First draft

Deploy on every push.

**On the screen**
- GitHub webhook URL and secret, each with Copy
- Four numbered setup steps

**Buttons**
- `Copy`

**Talks to the server**
- `GET /apps/:id/webhook`

**Checks before the user's OK**
- [ ] The URL uses the Public URL from Settings

### databases only — Backups

- **Where:** `/apps/:id?section=backups`
- **Kind:** Configuration section
- **Status:** First draft

Scheduled backups with a restore test after each one. Only for database apps.

**On the screen**
- Schedule, keep last N, local or S3, verify after backup
- Run now; history with a Verified badge
- Restore, with the app name typed to confirm

**Buttons**
- `Save`
- `Run now`
- `Restore`

**Talks to the server**
- `GET /backups?appId=`
- `POST /backups`
- `POST /backups/:id/run`
- `POST /backup-runs/:id/restore`

**Checks before the user's OK**
- [ ] The S3 secret is never shown back
- [ ] Restore cannot be clicked without the typed name

### Danger Zone

- **Where:** `/apps/:id?section=danger`
- **Kind:** Configuration section
- **Status:** First draft

Delete the app.

**On the screen**
- Delete app, with the name typed to confirm
- Checkbox: Also delete volumes (data)

**Buttons**
- `Delete app`

**Talks to the server**
- `DELETE /apps/:id?volumes=1`

**Checks before the user's OK**
- [ ] The volumes box is off by default

### S11 — Deployments

- **Where:** `/apps/:id?tab=deployments`
- **Kind:** Tab inside a screen
- **Status:** First draft

The build history.

**On the screen**
- Table: Status, Commit or image with the short hash, Trigger (manual, push, rollback, API, Claude), Started, Duration
- Actions: View log, Roll back to this
- The current deployment carries a 'current' tag

**Buttons**
- `View log`
- `Roll back to this`

**Talks to the server**
- `GET /deployments?appId=`
- `POST /apps/:id/rollback`

**Checks before the user's OK**
- [ ] Roll back asks to confirm and then opens the new deployment

**Linked to**
- → S15 Deployment log (View log)

### S12 — Logs

- **Where:** `/apps/:id?tab=logs`
- **Kind:** Tab inside a screen
- **Status:** First draft

The running app's output, live.

**On the screen**
- Black log box (#050505), 12px mono, fills the screen height
- Toolbar: Follow (on by default), Pause, filter box, Clear, Download
- Lines stream live; scrolling up pauses Follow

**Buttons**
- `Follow`
- `Pause`
- `Clear`
- `Download`

**Talks to the server**
- `stream /apps/:id/logs/stream`
- `GET /apps/:id/logs?tail=`

**Checks before the user's OK**
- [ ] 1,000+ lines stay smooth
- [ ] Color codes in logs show as plain text, no stray characters

### S13 — Terminal

- **Where:** `/apps/:id?tab=terminal`
- **Kind:** Tab inside a screen
- **Status:** First draft

Run a command inside the app's container. One command at a time, 30 second limit.

**On the screen**
- Command input with a $ prompt at the bottom; Enter runs it
- Each result shows the command, the exit code, the time taken and the output, errors in red
- Up and Down recall earlier commands
- A note at the top: each command runs on its own, no shared shell, 30 second limit

**Buttons**
- `Run`

**Talks to the server**
- `POST /apps/:id/exec`

**Checks before the user's OK**
- [ ] A clear message when the app is not running
- [ ] Long output scrolls inside its block

**Issues / decisions**
- D5 — Terminal: one command at a time, or a real shell?

### S14 — Metrics

- **Where:** `/apps/:id?tab=metrics`
- **Kind:** Tab inside a screen
- **Status:** First draft

CPU, memory and network for this app's containers.

**On the screen**
- Range picker
- Charts: CPU %, Memory (MB), Network in and out

**Buttons**
- `Range picker`

**Talks to the server**
- `GET /apps/:id/metrics?range=`

**Checks before the user's OK**
- [ ] Same chart style as the server page

### S15 — /deployments/:id — Deployment log

- **Where:** `/deployments/:id`
- **Kind:** Screen
- **Status:** First draft

One build, live.

**On the screen**
- Breadcrumbs Apps › e2e-sample › Deployment 1ff63b35, and the status
- Facts row: Trigger, Commit, Image, Started, Duration (ticks while running)
- Black log box: gray timestamps, red error lines, gray system lines; live while building, auto-scroll

**Buttons**
- `Cancel (while running)`
- `Redeploy`
- `Roll back to this`
- `Download log`

**Talks to the server**
- `GET /deployments/:id`
- `stream /deployments/:id/logs/stream`
- `POST /deployments/:id/cancel`

**Checks before the user's OK**
- [ ] Status moves Building → Deploying → Succeeded without a reload
- [ ] Scrolling up pauses auto-scroll; a Follow button turns it back on

**Linked to**
- → S10 Configuration (breadcrumb back to the app)
- ← S9 New resource (Create & Deploy opens the live log)
- ← S11 Deployments (View log)
- ← S8 Apps list ('Last deploy' links to that deployment)

### S16 — /alerts — Alerts

- **Where:** `/alerts`
- **Kind:** Screen
- **Status:** First draft

Four tabs: Firing, History, Rules, Notifications. Firing shows its count in red.

**On the screen**
- Firing: Severity (dot and word), Alert (title and one line of detail), Target (server / app link), Value, Firing for, Acknowledge
- History: the same table for resolved alerts, with Started and Resolved; filter by server and app
- Rules: On/off checkbox, Name, Condition ('CPU above 90% for 5m'), Severity, Applies to, Channels; Add and Edit open a form; the 10 default rules are marked Default
- Notifications: channels (Discord, Slack, Telegram, Webhook, Email) with On/off, Test, Edit, Delete; the Add form changes by type; secret fields show '••• set' and stay unchanged when left blank

**Buttons**
- `Acknowledge`
- `Add rule`
- `Edit`
- `Add channel`
- `Test`
- `Delete`

**Talks to the server**
- `GET /alerts`
- `POST /alerts/:id/ack`
- `GET/POST/PATCH/DELETE /alert-rules`
- `GET/POST/PATCH/DELETE /notification-channels`
- `POST /notification-channels/:id/test`

**Checks before the user's OK**
- [ ] Test sends a real message and shows Sent or the error
- [ ] Fix I1 and I2 here

**Issues / decisions**
- I1 — Fixed 5 Nov: the demo showed a false 'e2e-sample is down' alert
- I2 — Fixed 5 Nov: alert messages showed raw backticks around the Claude hint

**Linked to**
- → Diagnose panel (an alert names /docksy:diagnose <server>)
- ← Alerts (opens)

### S17 — /uptime — Uptime

- **Where:** `/uptime`
- **Kind:** Screen
- **Status:** First draft

Checks that ping your sites.

**On the screen**
- Header and Add check
- Table: Name, URL, Status dot, Uptime 24h %, Avg response (ms), 90-day bar strip (gray no data, green up, red a down day), Check now, Edit, Delete
- Add/Edit form: Name, URL, Check every (30s to 1h), Timeout, Expected status code (0 = any 2xx/3xx), Show on status page

**Buttons**
- `Add check`
- `Check now`
- `Edit`
- `Delete`

**Talks to the server**
- `GET/POST/PATCH/DELETE /uptime-checks`
- `GET /uptime-checks/:id/results`
- `POST /uptime-checks/:id/run`

**Checks before the user's OK**
- [ ] A down check turns red within 2 checks

**Issues / decisions**
- I1 — Fixed 5 Nov: the demo showed a false 'e2e-sample is down' alert

**Linked to**
- ← Uptime (opens)

### S18 — /settings — Settings

- **Where:** `/settings`
- **Kind:** Screen
- **Status:** First draft

Instance settings with a left sub-menu, like Coolify. Each section has its own Save.

**On the screen**
- General: Instance name, Public URL (with why it matters: agents, webhooks and Claude use it)
- Status page: on/off, Title, a link to the public page
- Monitoring: keep metrics for N days
- API tokens: table of name, prefix, scope (full, read-only), last used, created, Revoke; Create shows the token once with Copy
- SSH key: Docksy's public key and fingerprint, Copy, and the one-line command to add it to a server
- About: version, GitHub link, 'Free and open source, forever.'

**Buttons**
- `Save (per section)`
- `Create token`
- `Revoke`
- `Copy`

**Talks to the server**
- `GET/PATCH /settings`
- `GET/POST/DELETE /tokens`
- `GET /ssh-key`
- `GET /health`

**Checks before the user's OK**
- [ ] Public URL refuses a trailing slash or a path
- [ ] A new token is shown once and cannot be shown again

**Linked to**
- → Settings sections (sub-menu)
- → S20 Status page (turned on in Settings › Status page)
- ← Settings (opens)

### S19 — /claude — Claude setup

- **Where:** `/claude`
- **Kind:** Screen
- **Status:** First draft

How to connect Claude Code to this Docksy. Numbered steps and plain code boxes with Copy.

**On the screen**
- 1 Create a token: scope select (Full, Read-only), Create token; the token then fills every snippet
- 2 Install the plugin: /plugin marketplace add crovenai/docksy, then /plugin install docksy@docksy
- 3 Point Claude at Docksy: the export lines, the claude mcp add command, the .mcp.json file; a Read-only tools checkbox
- 4 What Claude can do: tools in three groups (read, change, destructive), one line each
- 5 Try asking: five example prompts

**Buttons**
- `Create token`
- `Copy`

**Talks to the server**
- `POST /tokens`
- `GET /settings`

**Checks before the user's OK**
- [ ] Snippets show the real Public URL and the new token

**Linked to**
- ← Claude (opens)

### S20 — /status — Status page

- **Where:** `/status`
- **Kind:** Screen · no login
- **Status:** First draft

The public status page. No sidebar, no login. Shown only when turned on in Settings.

**On the screen**
- Title from Settings
- Overall line: All systems operational, Some systems degraded, or Major outage, with a dot
- One row per public check: name, status, 90-day uptime %, 90 small day bars
- Footer: Updated 1 minute ago · Powered by Docksy
- URLs of checks are never shown

**Buttons**
- none

**Talks to the server**
- `GET /public/status`

**Checks before the user's OK**
- [ ] Shows a plain 'Status page is turned off' when disabled
- [ ] Day bars stay readable at 390px

**Linked to**
- ← S18 Settings (turned on in Settings › Status page)

### S21 — 404 — Not found

- **Where:** `any wrong URL`
- **Kind:** Screen · no login
- **Status:** First draft

Inside the shell: Page not found, one line, two buttons.

**On the screen**
- Title, one line of help

**Buttons**
- `Go to Overview`
- `Back`

**Talks to the server**
- none

**Checks before the user's OK**
- [ ] A wrong app or server id shows 'App not found' inside its page, not a blank screen

## Sidebar items and other boxes

| Box | Kind | What |
|---|---|---|
| Overview | Sidebar item | Sidebar item. Opens the Overview. |
| Servers | Sidebar item | Sidebar item. Opens the servers list. |
| Apps | Sidebar item | Sidebar item. Opens the apps list. |
| Alerts (red count) | Sidebar item | Sidebar item. Shows a red number while alerts fire. |
| Uptime | Sidebar item | Sidebar item. Opens the uptime checks. |
| Claude | Sidebar item | Sidebar item. Opens the Claude setup page. |
| Settings | Sidebar item | Sidebar item. Opens Settings. |
| Configuration (S10 · tab) | Screen | The app's settings, like Coolify's Configuration screen: a left sub-menu of nine sections, each with its own Save. The page header above the tabs shows breadcrumbs Apps › e2e-vps › e2e-sample, ● Running and the domain link; on the right Redeploy (white), Restart, Stop or Start, and Rollback when an earlier good deploy exists. |
| Header actions | Panel | The buttons at the top right of every app tab. |
| Settings sections | Panel | The six sections of the Settings sub-menu. |

## Design rules (the same tokens as the product)

### Colors

| Rule | Value | Where |
|---|---|---|
| Page background | #0a0a0a, near black | behind everything |
| Panels, inputs, sidebar | #121212 | form fields, tables, cards |
| Hover, active menu item | #1a1a1a | the selected sidebar item, table headers |
| Borders | #262626, strong #333333 | around inputs, tables, cards |
| Text | #ededed main · #8f8f8f secondary · #5c5c5c faint | titles and values · descriptions · placeholders and chart axes |
| Status only | green #22c55e · yellow #eab308 · red #ef4444 | a small dot and one word: ● Running, ● Deploying, ● Failed. Never a colored pill background |
| Not allowed | gradients, glow, shadows, blur, blue, violet, colored icon boxes, animated decorations, a light theme | anywhere |

### Text

| Rule | Value | Where |
|---|---|---|
| Base | 14px | body text |
| Page title | 20px semibold | top of every page |
| Section title | 18px semibold, Save button beside it | every form section, like Coolify's General [Save] |
| Field label | 14px white, red * when required | above every input |
| Help text | 12px gray, one line | under a field |
| Section description | one line, 14px gray | under every section title ('General configuration for your application.') |

### Controls

| Rule | Value | Where |
|---|---|---|
| Primary button | white, black text, 32px high | the one main action of a view: Redeploy, Create, Save when changed |
| Secondary button | dark gray, white text, border | every other action |
| Danger button | dark gray, red text | delete, remove, anything that loses data |
| Input | 36px high, #121212, border #262626, white border on focus | every text field and select |
| Checkbox | 16px square, white check when on | on/off settings |
| Corners | 6px | buttons, inputs, cards |

### Charts and states

| Rule | Value | Where |
|---|---|---|
| Lines | 1.5px, white and grays (CPU #e5e5e5, memory #a3a3a3, disk #737373), no colored fills | every chart |
| Grid and axis | dark grid lines, small gray axis text, dashed line for an alert limit | every chart |
| Loading | gray spinner and 'Loading…', never a blank page | every screen |
| Empty | dashed box, one title, one line, one button | every list |
| Error | red bordered box with the server's message and Retry | every screen |
| Saving | the button shows a spinner and is disabled | every form |

## Issues and decisions

### I1 · Fixed 5 Nov: the demo showed a false 'e2e-sample is down' alert

- **Severity:** fixed
- **What you see:** A red critical alert on Overview and Alerts for an app that is running and healthy.
- **Why:** After the first successful deploy, Docksy creates an uptime check for the app's domain. In the demo that domain is e2e-sample.localhost, a name only the fake server can resolve. The check fails from the control plane, so the alert fires.
- **Fix / check:** Done: Docksy no longer creates the automatic check for localhost, .localhost, .local, .internal or private IPs (isPublicHost in monitoring/uptime/index.ts, with a test). The bad check was deleted from the demo and the alert resolved.
- **Code:** apps/server/src/monitoring/uptime/index.ts (auto-check on deployment.finished) · the alert text comes from monitoring/alerts/notify.ts

### I2 · Fixed 5 Nov: alert messages showed raw backticks around the Claude hint

- **Severity:** fixed
- **What you see:** On the Alerts page: Ask Claude: `/docksy:diagnose e2e-sample` with the backtick characters visible.
- **Why:** The hint is written for chat tools (Discord, Slack) where backticks make code text. The web page prints the string as-is.
- **Fix / check:** Done: the uptime alert text no longer contains backticks (Discord and Slack keep their own formatting in notify.ts). The Alerts page will show the hint as a code chip when S16 is built.
- **Code:** apps/web/src/pages/Alerts.tsx (message column) · apps/server/src/monitoring/alerts/notify.ts (hint text)

### I3 · The drafts were checked by screenshot only

- **Severity:** medium
- **What you see:** A button that looks right but does nothing, or a form that saves the wrong field.
- **Why:** The screenshot tool cannot click or type. Each draft was looked at, not used. The Add server wizard, New resource, the nine Configuration sections and Settings all have forms that were never submitted from the browser.
- **Fix / check:** Part of the build loop: before a screen is sent for your OK, every button on it is clicked on the demo and every form is saved once.
- **Code:** scripts/shot.mjs takes screenshots only. A click-through needs a browser driver, or me using the browser directly.

### D1 · Decision: Projects and environments, or a flat Apps list?

Coolify groups apps as Project › production › app. Docksy today has one flat Apps list with a server filter.

Options: **Flat Apps list for v0.1, projects later** (chosen default) / Projects and environments now

### D2 · Decision: Live charts on the server page, or numbers only?

The server page has four live gray charts plus the per-core strip. A simpler page would keep the tiles and drop the charts.

Options: **Keep the charts, in gray** (chosen default) / Numbers and bars only, no charts

### D3 · Decision: Sidebar icons?

Small gray icons next to each sidebar word, like Coolify, or words only.

Options: **Keep small gray icons** (chosen default) / Words only

### D4 · Decision: Which font?

The drafts use Inter. The system font is the other choice and needs no download.

Options: **Inter** (chosen default) / System font

### D5 · Decision: Terminal: one command at a time, or a real shell?

Today each command runs on its own with a 30 second limit. Coolify opens a real interactive shell, which needs a websocket and more backend work.

Options: **One command at a time for v0.1** (chosen default) / Real interactive shell now

### D6 · Decision: Phone support?

Every screen must not break on a phone. Making every screen fully usable on a phone takes longer.

Options: **Desktop first; phone must not break** (chosen default) / Every screen fully usable on a phone

### D7 · Decision: How do you review each screen?

I can send screenshots in chat, or you open the demo and click through yourself, or both.

Options: **Both: screenshots in chat, demo open at localhost:8080** (chosen default) / Screenshots only / I click through the demo myself

