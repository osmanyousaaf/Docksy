-- Docksy SQLite schema. Timestamps are unix milliseconds (INTEGER).
-- JSON columns are TEXT holding JSON. *_enc columns hold encrypt() output.
-- Owned by the integrator: changes go through CONTRACT.md, never edited ad-hoc.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,               -- sha256(token)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,   -- sha256(plaintext)
  prefix TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'full',
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                -- JSON
);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  ssh_user TEXT NOT NULL DEFAULT 'root',
  status TEXT NOT NULL DEFAULT 'new',
  agent_token_hash TEXT UNIQUE,      -- sha256(dsa_...)
  agent_version TEXT,
  last_seen_at INTEGER,
  os TEXT,
  arch TEXT,
  cpu_cores INTEGER,
  mem_total INTEGER,
  disk_total INTEGER,
  provision_log TEXT,
  host_key TEXT,                     -- sha256 host-key fingerprint pinned on first connect (TOFU)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL DEFAULT 'app',
  template TEXT,
  source_type TEXT NOT NULL DEFAULT 'git',
  repo_url TEXT,
  branch TEXT,
  git_token_enc TEXT,
  image TEXT,
  build_type TEXT NOT NULL DEFAULT 'auto',
  dockerfile_path TEXT NOT NULL DEFAULT 'Dockerfile',
  build_context TEXT NOT NULL DEFAULT '.',
  compose_path TEXT NOT NULL DEFAULT 'docker-compose.yml',
  port INTEGER,
  domains TEXT NOT NULL DEFAULT '[]',
  healthcheck_path TEXT,
  volumes TEXT NOT NULL DEFAULT '[]',
  start_command TEXT,               -- overrides the image CMD (run via sh -c)
  watch_paths TEXT NOT NULL DEFAULT '[]', -- JSON globs; webhook deploys only when a changed file matches
  cpu_limit REAL,                    -- docker --cpus
  mem_limit_mb INTEGER,              -- docker --memory
  status TEXT NOT NULL DEFAULT 'idle',
  auto_deploy INTEGER NOT NULL DEFAULT 1,
  webhook_secret TEXT NOT NULL,
  current_deployment_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_env (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  PRIMARY KEY (app_id, key)
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  trigger TEXT NOT NULL DEFAULT 'manual',
  ref TEXT,                          -- branch/sha override requested for this deployment
  commit_sha TEXT,
  commit_message TEXT,
  image_tag TEXT,
  error TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deployments_app ON deployments(app_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deployment_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  stream TEXT NOT NULL DEFAULT 'stdout',
  line TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deployment_logs ON deployment_logs(deployment_id, id);

-- res: 0 = raw (agent interval), 60 = 1-minute rollup, 3600 = 1-hour rollup
CREATE TABLE IF NOT EXISTS metrics (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  res INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  cpu REAL NOT NULL,
  load1 REAL NOT NULL,
  load5 REAL NOT NULL DEFAULT 0,
  load15 REAL NOT NULL DEFAULT 0,
  mem_used INTEGER NOT NULL,
  mem_total INTEGER NOT NULL,
  swap_used INTEGER NOT NULL,
  disk_used INTEGER NOT NULL,
  disk_total INTEGER NOT NULL,
  net_rx REAL NOT NULL,
  net_tx REAL NOT NULL,
  PRIMARY KEY (server_id, res, ts)
);

CREATE TABLE IF NOT EXISTS container_metrics (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  container_name TEXT NOT NULL,
  res INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  app_id TEXT,
  cpu REAL NOT NULL,
  mem_used INTEGER NOT NULL,
  net_rx REAL NOT NULL,
  net_tx REAL NOT NULL,
  PRIMARY KEY (server_id, container_name, res, ts)
);
CREATE INDEX IF NOT EXISTS idx_container_metrics_app ON container_metrics(app_id, res, ts);
CREATE INDEX IF NOT EXISTS idx_container_metrics_srv ON container_metrics(server_id, res, ts);

-- latest snapshot of every container per server (replaced on each agent report)
CREATE TABLE IF NOT EXISTS container_state (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  container_id TEXT NOT NULL,
  name TEXT NOT NULL,
  image TEXT NOT NULL,
  state TEXT NOT NULL,
  status TEXT NOT NULL,
  restart_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  cpu REAL NOT NULL DEFAULT 0,
  mem_used INTEGER NOT NULL DEFAULT 0,
  mem_limit INTEGER NOT NULL DEFAULT 0,
  net_rx REAL NOT NULL DEFAULT 0,
  net_tx REAL NOT NULL DEFAULT 0,
  labels TEXT NOT NULL DEFAULT '{}',
  app_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, container_id)
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  op TEXT NOT NULL DEFAULT '>',
  threshold REAL NOT NULL DEFAULT 0,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  severity TEXT NOT NULL DEFAULT 'warning',
  server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
  app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
  channel_ids TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  rule_id TEXT REFERENCES alert_rules(id) ON DELETE SET NULL,
  server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
  app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,          -- rule_id + server/app/container; one firing alert per key
  state TEXT NOT NULL DEFAULT 'firing',
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  value REAL,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  acked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_state ON alerts(state, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_dedupe ON alerts(dedupe_key, state);

CREATE TABLE IF NOT EXISTS notification_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config_enc TEXT NOT NULL,          -- encrypt(JSON)
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS uptime_checks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
  interval_sec INTEGER NOT NULL DEFAULT 60,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  expected_status INTEGER NOT NULL DEFAULT 0,
  public INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS uptime_results (
  check_id TEXT NOT NULL REFERENCES uptime_checks(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT,
  PRIMARY KEY (check_id, ts)
);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  schedule TEXT NOT NULL DEFAULT 'daily',
  retention INTEGER NOT NULL DEFAULT 7,
  destination TEXT NOT NULL DEFAULT 'local',
  s3_config_enc TEXT,                -- encrypt(JSON incl. secretKey)
  verify INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  backup_id TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running',
  verified TEXT NOT NULL DEFAULT 'pending',
  size_bytes INTEGER,
  path TEXT,
  log TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts DESC);
