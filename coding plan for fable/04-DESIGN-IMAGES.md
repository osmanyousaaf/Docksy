# Design images

Every picture in the plan, in one place: the software diagrams, every screen of the new grayscale UI as it exists today, and the logo. All files are under [images/](images/). The screens are the current drafts; each one gets rebuilt and approved through the loop in [03-TEAM.md](03-TEAM.md), and its approved screenshot replaces the draft here.

## 1. Software diagrams

| | |
|---|---|
| ![Architecture](images/diagrams/01-architecture.png) | ![Data model](images/diagrams/02-data-model.png) |
| 01 · System architecture | 02 · Data model |
| ![Add a server](images/diagrams/03-add-server.png) | ![Deploy](images/diagrams/04-deploy.png) |
| 03 · Flow: add a server (S6) | 04 · Flow: deploy an app (S9 → S15) |
| ![Alert](images/diagrams/05-alert.png) | ![Screen flow](images/diagrams/06-screen-flow.png) |
| 05 · Flow: an alert fires (S16) | 06 · How the 21 screens connect |
| ![Team](images/diagrams/07-team.png) | ![Phases](images/diagrams/08-phases.png) |
| 07 · The team and hand-overs | 08 · Phases and build order |
| ![Screen loop](images/diagrams/09-screen-loop.png) | ![Screen map](images/screen-map-and-plan.png) |
| 09 · The loop for one screen | The full interactive screen map, rendered |

## 2. The UI, screen by screen (new grayscale design, current drafts)

Desktop at 1440 px, full page. Phone shots (390 px) are in [images/screens/phone/](images/screens/phone/).

### Frame and sign-in

| Screen | Image |
|---|---|
| S2 Login | ![S2](images/screens/desktop/login.png) |
| S3 First-time setup (redirects to Overview on the demo because an owner already exists; the form is the same as Login's layout) | ![S3](images/screens/desktop/setup.png) |
| S4 Overview (inside the S1 frame) | ![S4](images/screens/desktop/root.png) |
| S4 on a phone | ![S4 phone](images/screens/phone/root.png) |

### Servers

| Screen | Image |
|---|---|
| S5 Servers list | ![S5](images/screens/desktop/servers.png) |
| S6 Add server | ![S6](images/screens/desktop/servers_new.png) |
| S7 Server detail › Overview | ![S7](images/screens/desktop/servers_1616a04a_f971_4de1_828a_45b8242e3e8e.png) |
| S7 › Containers | ![S7 containers](images/screens/desktop/servers_1616a04a_f971_4de1_828a_45b8242e3e8e_tab_containers.png) |
| S7 › Configuration | ![S7 configuration](images/screens/desktop/servers_1616a04a_f971_4de1_828a_45b8242e3e8e_tab_configuration.png) |
| S7 › Danger Zone | ![S7 danger](images/screens/desktop/servers_1616a04a_f971_4de1_828a_45b8242e3e8e_tab_danger.png) |
| S7 › Diagnose panel | ![S7 diagnose](images/screens/desktop/servers_1616a04a_f971_4de1_828a_45b8242e3e8e_diagnose_1.png) |
| S7 on a phone | ![S7 phone](images/screens/phone/servers_1616a04a_f971_4de1_828a_45b8242e3e8e.png) |

### Apps

| Screen | Image |
|---|---|
| S8 Apps list | ![S8](images/screens/desktop/apps.png) |
| S9 New resource | ![S9](images/screens/desktop/apps_new.png) |
| S10 Configuration › General | ![S10 general](images/screens/desktop/apps_9d0abfe4_ec19_4117_ba68_ef6fd58c8a29.png) |
| S10 › Source | ![S10 source](images/screens/desktop/apps_9d0abfe4_ec19_4117_ba68_ef6fd58c8a29_section_source.png) |
| S10 › Environment Variables | ![S10 env](images/screens/desktop/apps_9d0abfe4_ec19_4117_ba68_ef6fd58c8a29_section_environment.png) |
| S10 › Persistent Storage | ![S10 storage](images/screens/desktop/apps_9d0abfe4_ec19_4117_ba68_ef6fd58c8a29_section_storage.png) |
| S10 › Health Check | ![S10 health](images/screens/desktop/apps_9d0abfe4_ec19_4117_ba68_ef6fd58c8a29_section_healthcheck.png) |
| S10 › Resource Limits | ![S10 limits](images/screens/desktop/apps_9d0abfe4_ec19_4117_ba68_ef6fd58c8a29_section_limits.png) |
| S10 › Webhooks | ![S10 webhooks](images/screens/desktop/apps_9d0abfe4_ec19_4117_ba68_ef6fd58c8a29_section_webhooks.png) |
| S10 › Danger Zone | ![S10 danger](images/screens/desktop/apps_9d0abfe4_ec19_4117_ba68_ef6fd58c8a29_section_danger.png) |
| S11 Deployments tab | ![S11](images/screens/desktop/apps_9d0abfe4_ec19_4117_ba68_ef6fd58c8a29_tab_deployments.png) |
| S12 Logs tab | ![S12](images/screens/desktop/apps_9d0abfe4_ec19_4117_ba68_ef6fd58c8a29_tab_logs.png) |
| S13 Terminal tab | ![S13](images/screens/desktop/apps_9d0abfe4_ec19_4117_ba68_ef6fd58c8a29_tab_terminal.png) |
| S14 Metrics tab | ![S14](images/screens/desktop/apps_9d0abfe4_ec19_4117_ba68_ef6fd58c8a29_tab_metrics.png) |
| S15 Deployment log | ![S15](images/screens/desktop/deployments_1ff63b35_da0b_4121_9899_547b970cbc25.png) |
| S10 on a phone | ![S10 phone](images/screens/phone/apps_9d0abfe4_ec19_4117_ba68_ef6fd58c8a29.png) |

(The Backups section only shows for databases; the demo app is a plain app, so there is no screenshot yet.)

### Monitoring, settings, public

| Screen | Image |
|---|---|
| S16 Alerts › Firing | ![S16](images/screens/desktop/alerts.png) |
| S16 › History | ![S16 history](images/screens/desktop/alerts_tab_history.png) |
| S16 › Rules | ![S16 rules](images/screens/desktop/alerts_tab_rules.png) |
| S16 › Notifications | ![S16 notifications](images/screens/desktop/alerts_tab_notifications.png) |
| S17 Uptime | ![S17](images/screens/desktop/uptime.png) |
| S18 Settings | ![S18](images/screens/desktop/settings.png) |
| S19 Claude setup | ![S19](images/screens/desktop/claude.png) |
| S20 Public status page | ![S20](images/screens/desktop/status.png) |
| S21 Not found | ![S21](images/screens/desktop/this_page_does_not_exist.png) |
| S16 on a phone | ![S16 phone](images/screens/phone/alerts.png) |

### The reference

![Coolify](images/reference-coolify-app-config.png)

Coolify's application configuration page. This is what "complete and formal" means for every Docksy screen: breadcrumbs, page tabs, left sub-nav, section title with the Save button beside it, one-line description, flat forms.

## 3. Logo

| | |
|---|---|
| ![Lockup dark](images/logo/logo-lockup-dark.png) | ![Lockup light](images/logo/logo-lockup-light.png) |
| Lockup on black | Lockup on white |
| ![Mark dark](images/logo/logo-mark-dark.png) | ![Mark light](images/logo/logo-mark-light.png) |
| The mark, white | The mark, black |
| ![Icon](images/logo/logo-icon.png) | ![Sizes](images/logo/logo-sizes.png) |
| App icon (mark on a black tile) | 256 → 16 px: it must stay readable at favicon size |

The mark is a capital **D built like a shipping container**: a rounded body with two ribs. Letter first, crate second. Grayscale only; the green dot in the UI is status, never part of the logo. Vector sources: `docksy-mark.svg`, `docksy-icon.svg`, `docksy-lockup-white.svg`, `docksy-lockup-black.svg` (also in `../brand/`).

### Banners

| | |
|---|---|
| ![GitHub](images/logo/banner-github-social-preview.png) | GitHub social preview, 1280 × 640 |
| ![X](images/logo/banner-x-header.png) | X header, 1500 × 500 |
| ![README](images/logo/banner-readme-hero.png) | README hero, 1600 × 400 |

### Alternatives considered

![Logo grid](images/logo-grid-20.png)

Twenty marks were drawn (interactive picker: https://claude.ai/artifact/3QfQVK8x6iU1FgKFh2Pngc). Against the competitors, Coolify (a purple pixel "C") and Dokploy (a black whale), the open position is "a letterform, in black, no sea animal". Candidates that hold it: #1 ribbed D (in use), #4 corrugated D, #20 notched D, #6 D in a tile. The founder's final pick is still open.
