# Security policy

Docksy holds SSH access to your servers and the secrets of your apps, so we take security seriously. Thank you for helping keep its users safe.

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for security problems.**

Report privately through GitHub's private vulnerability reporting:

1. Go to <https://github.com/osmanyousaaf/docksy/security/advisories/new>
   (or the **Security** tab → **Report a vulnerability**).
2. Include:
   - the affected component (server API, web UI, agent, CLI, MCP server, Claude Code plugin, install script)
   - the version or commit
   - the steps to reproduce, or a proof of concept
   - the impact as you understand it
   - any suggested fix

## What to expect

| When | What |
|---|---|
| within 3 business days | we acknowledge your report |
| within 10 business days | we give an initial assessment and severity |
| as soon as practical | we ship a fix: critical issues are prioritised over all other work |
| after the fix is released | we publish a GitHub Security Advisory and request a CVE if appropriate |

We'll keep you updated and credit you in the advisory unless you'd rather stay anonymous. Docksy is a free project with no bug bounty, but we're grateful for every report.

## Supported versions

Security fixes go into the latest release. Please update to the latest version before reporting. Docksy is idempotent to update: re-run the installer, or `docker compose pull && docker compose up -d`.

## Scope

In scope:
- authentication, sessions, API tokens, agent tokens and webhook signature checks
- encryption of secrets at rest, and exposure of secrets in API responses, logs or the UI
- command injection in anything that runs over SSH (deploys, provisioning, backups)
- privilege escalation between roles or token scopes
- the `install.sh` installer and the published container image
- the MCP server and Claude Code plugin, including bypasses of destructive-action confirmation

Out of scope:
- vulnerabilities in apps that users deploy *with* Docksy
- issues that require an already-compromised server or control-plane host
- denial of service from unrealistic traffic volumes
- missing security headers without a demonstrated impact

## Safe harbour

We won't pursue legal action against good-faith research that respects user data and privacy, avoids service disruption, and gives us reasonable time to fix the issue before disclosure. Test only against instances you own.
