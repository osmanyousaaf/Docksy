D['01-architecture'] = { title: 'System architecture', sub: 'One Docksy process, one SQLite file, SSH out to each VPS, a small Go agent reporting back every 10 seconds.', code: `
flowchart LR
  subgraph user["Your machine"]
    B["Browser · React UI"]
    CC["Claude Code · plugin + MCP"]
    CLI["docksy CLI"]
  end
  subgraph cp["Docksy server · one container or Node process"]
    API["Hono API · /api/v1"]
    DB[("SQLite · node:sqlite")]
    Q["Deploy queue"]
    SCH["Schedulers · uptime · alerts · backups · retention"]
    SSE["SSE streams · logs · metrics · deploy log"]
  end
  subgraph vps["Each VPS you add"]
    SSH["sshd"]
    D["Docker"]
    CADDY["Caddy proxy · auto HTTPS"]
    AG["docksy-agent · Go"]
    C1["app containers"]
  end
  B --> API
  CC --> API
  CLI --> API
  API --> DB
  API --> Q --> SSH
  SSH --> D --> C1
  D --> CADDY
  AG -- "POST /api/agent/v1/report · 10 s" --> API
  SCH --> API
  API --> SSE --> B
` };

D['02-data-model'] = { title: 'Data model', sub: 'The SQLite tables that matter and how they relate. Secrets are encrypted at rest; env values are masked in every response.', code: `
erDiagram
  users ||--o{ api_tokens : has
  servers ||--o{ apps : hosts
  servers ||--o{ metrics : reports
  servers ||--o{ container_state : reports
  servers ||--o{ provision_jobs : runs
  apps ||--o{ deployments : has
  apps ||--o{ app_env : has
  apps ||--o{ container_metrics : reports
  apps ||--o{ uptime_checks : "auto-created"
  apps ||--o{ backups : has
  alert_rules ||--o{ alerts : fires
  servers ||--o{ alerts : about
  apps ||--o{ alerts : about
  uptime_checks ||--o{ uptime_results : records
  users ||--o{ activity : did
  servers {
    text id PK
    text name
    text host
    text ssh_user
    text status
    int last_seen_at
  }
  apps {
    text id PK
    text server_id FK
    text name
    text kind
    text source_type
    text build_type
    int port
    json domains
    json volumes
    text status
    int auto_deploy
  }
  deployments {
    text id PK
    text app_id FK
    text status
    text trigger
    text commit_sha
    text image_tag
    text log
  }
  metrics {
    text server_id FK
    int ts
    real cpu
    real load1
    int mem_used
    int disk_used
    int net_rx
    int net_tx
  }
  alerts {
    text id PK
    text rule_id FK
    text state
    text severity
    text title
    int started_at
    int resolved_at
  }
` };

D['03-add-server'] = { title: 'Flow · Add a server (S6)', sub: 'From an empty form to live metrics in about two minutes.', code: `
sequenceDiagram
  participant U as User · S6 wizard
  participant A as Docksy API
  participant V as VPS
  U->>A: POST /servers {name, host, user, port}
  A-->>U: server (status new) + Docksy's public key
  U->>V: paste one line: add key to authorized_keys
  U->>A: POST /servers/:id/validate
  A->>V: ssh whoami · docker --version · uname
  A-->>U: ok, or a clear error (502 server_unreachable)
  U->>A: POST /servers/:id/provision
  A->>V: provision.sh (Docker, Caddy, network) then install-agent.sh
  A-->>U: SSE /servers/:id/provision/stream · log lines
  V->>A: agent POST /api/agent/v1/report every 10 s
  A-->>U: status ready · liveness online · first metrics
` };

D['04-deploy'] = { title: 'Flow · Deploy an app (S9 → S15)', sub: 'Zero downtime: the new container must be healthy before the old one goes. Rollback runs the previous image through the same path.', code: `
flowchart TD
  T["Trigger · Deploy button · GitHub push · CLI · MCP"] --> Q["Enqueue deployment · one at a time per app"]
  Q --> S{"source"}
  S -- git --> G["git clone --depth 1 on the VPS · token via askpass"]
  S -- image --> P["docker pull"]
  S -- template --> P
  G --> BT{"build type"}
  BT -- Dockerfile / auto --> BD["docker build -t docksy/app:deploy8"]
  BT -- compose --> CO["docker compose -p docksy-app up -d"]
  BD --> R["docker run new container · network docksy · --cpus --memory · labels · env · volumes · start command"]
  P --> R
  R --> H{"healthcheck path or port open?"}
  H -- healthy --> SW["Caddy routes the domain to the new container · stop and remove the old one"]
  H -- "unhealthy after timeout" --> F["Mark failed · keep the old container running"]
  SW --> OK["Mark succeeded · set current deployment"]
  CO --> OK
  OK --> UP["Auto-create uptime check · public hosts only"]
` };

D['05-alert'] = { title: 'Flow · An alert fires (S16)', sub: 'Rules ship enabled. Docksy collects the facts; Claude does the reasoning on your side.', code: `
flowchart LR
  AG["agent report"] --> ST["store metrics"]
  ST --> EV["alert engine · cpu · memory · disk · offline · restarts · container down"]
  UC["uptime scheduler"] -- "2 fails in a row" --> EV
  EV -- "true for N minutes" --> FIRE["alert firing"]
  FIRE --> N["notify · email · Discord · Slack · webhook · with 'Ask Claude: /docksy:diagnose app'"]
  FIRE --> UI["red count in sidebar · Overview · S16"]
  EV -- "condition clears" --> RES["alert resolved · notify again"]
  UI --> D["Diagnose panel · facts, no LLM"]
  D --> CC["Claude reads diagnose through MCP and proposes the fix"]
` };

D['06-screen-flow'] = { title: 'Screen flow · how the 21 screens connect', sub: 'Solid arrows are navigation; dashed arrows open a panel or tab on the same page.', code: `
flowchart LR
  subgraph pub["No login"]
    S2["S2 Login"]
    S3["S3 First-time setup"]
    S20["S20 Status page"]
    S21["S21 Not found"]
  end
  S3 --> S2 --> S4["S4 Overview"]
  subgraph shell["S1 Sidebar"]
    S4
    S5["S5 Servers"]
    S8["S8 Apps"]
    S16["S16 Alerts"]
    S17["S17 Uptime"]
    S19["S19 Claude"]
    S18["S18 Settings"]
  end
  S5 --> S6["S6 Add server"] --> S7["S7 Server detail"]
  S5 --> S7
  S7 -.-> S7c["Containers · Configuration · Danger zone"]
  S7 -.-> DG["Diagnose panel"]
  S8 --> S9["S9 New resource"] --> S10["S10 App · Configuration"]
  S8 --> S10
  S10 -.-> S11["S11 Deployments"] --> S15["S15 Deployment log"]
  S10 -.-> S12["S12 Logs"]
  S10 -.-> S13["S13 Terminal"]
  S10 -.-> S14["S14 Metrics"]
  S10 -.-> SEC["General · Source · Env · Storage · Health · Limits · Webhooks · Backups · Danger"]
  S16 -.-> DG
  S4 --> S7
  S4 --> S16
  S4 --> S15
` };

D['07-team'] = { title: 'The team · who hands what to whom', sub: 'Seven Claude Code agents. One screen at a time. Nothing is approved without QA and the-user.', code: `
flowchart LR
  U(("the-user · the founder")) -- "OK, or a numbered list" --> TL["team-lead"]
  TL -- brief --> BE["backend"]
  TL -- brief --> FE["frontend"]
  TL -- brief --> UX["ui-ux"]
  TL -- "Claude · MCP · CLI · plugin only" --> AI["ai-architect"]
  BE -- "routes · types · tests" --> TL
  FE -- "page · screenshots" --> TL
  UX -- "kit · copy · diff vs Coolify" --> TL
  AI -- "tools · commands · skills" --> TL
  TL -- "screen + checklist" --> QA["qa"]
  QA -- "PASS / FAIL list" --> TL
  TL -- screenshots --> U
` };

D['08-phases'] = { title: 'Phases and build order', sub: 'Each phase ends with the founder clicking through the demo once.', code: `
flowchart LR
  P0["0 · Foundation · done · backend, kit, demo, CI"] --> P1["1 · Frame · S1 done · S2 Login · S3 Setup · S4 Overview"]
  P1 --> P2["2 · Servers · S5 list · S6 add server · S7 detail"]
  P2 --> P3["3 · Apps · S8 list · S9 new · S10 config ×9 · S11–S15 tabs"]
  P3 --> P4["4 · Monitoring and the rest · S16 alerts · S17 uptime · S18 settings · S19 Claude · S20 status · S21 404"]
  P4 --> P5["5 · Release 0.1 · real VPS · tag · GHCR · npm · announce"]
` };

D['09-screen-loop'] = { title: 'The loop for one screen', sub: 'Brief → build → verify → founder review → fix → approve → commit.', code: `
flowchart TD
  A["1 · Brief · team-lead copies the screen from 02-SCREENS.md"] --> B["2 · Build · backend ∥ frontend, then ui-ux"]
  B --> C["3 · Verify · qa: suites, screenshots desktop + phone, click every button, submit every form"]
  C -- FAIL --> B
  C -- PASS --> D["4 · Review · the-user looks at the screenshots next to Coolify"]
  D -- "numbered list" --> B
  D -- "OK — Sx approved" --> E["5 · Approve · status ok · screenshots into images/ · one commit"]
  E --> F["next screen in build order"]
` };
