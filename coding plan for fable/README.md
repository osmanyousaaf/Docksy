# Coding plan for Fable

This folder is the hand-over pack for building Docksy with Claude Code (model: Claude Fable). It contains the whole plan, the screen-by-screen spec, the team of agents, and the pictures. A team lead opens the repo in Claude Code, reads this, and runs the build.

| File | What it is |
|---|---|
| [01-PLAN.md](01-PLAN.md) | The end-to-end plan: product, architecture diagrams, data model, how a deploy and an alert flow, the phases, the definition of done |
| [02-SCREENS.md](02-SCREENS.md) | Every screen (S1–S21), every section, button, API call and check, in build order, plus the design rules and the issues/decisions log |
| [03-TEAM.md](03-TEAM.md) | The seven agents, what each owns, how work is handed over, and the review loop |
| [04-DESIGN-IMAGES.md](04-DESIGN-IMAGES.md) | All the pictures: 9 software diagrams as PNG, every screen of the new UI (desktop + phone), the logo, the banners |
| [agents/](agents/) | Copies of the agent definitions. The live ones are in `../.claude/agents/` and Claude Code loads them from there |
| [images/](images/) | `diagrams/` (PNG flowcharts), `screens/desktop` and `screens/phone` (every screen), `logo/` (marks, lockups, icon, banners), the Coolify reference, the screen map |

## How to run the build (team lead)

1. Open the repo root in Claude Code: `cd docksy && claude`.
2. Start the demo backend once so every agent has real data to look at (fake VPS in Docker, takes about 5 minutes the first time):
   ```
   bash e2e/run.sh --keep      # or: scripts/dev.sh for a plain local server on :8080 and Vite on :5173
   ```
   Login for the demo: `e2e@docksy.local` / `e2e-correct-horse-battery`.
3. Type: **"You are team-lead. Read `coding plan for fable/README.md` and continue the build from the first screen that is not approved."**
4. The team lead takes one screen at a time: brief → backend / frontend / ui-ux (in parallel when possible) → qa → the-user → fix → approved → commit. See [03-TEAM.md](03-TEAM.md).
5. Agents are invoked by name with the Agent tool, for example `Agent(subagent_type: "frontend", prompt: "...")`. They only know what the prompt says, so the team lead pastes the screen's entry from `02-SCREENS.md` into it.

## State of the code today (5 Nov 2026)

- Backend: complete for v0.1 (219 server tests pass; e2e fake VPS → provision → deploy → metrics passes).
- Web UI: every screen has a first draft in the new grayscale style; **S1 (sidebar and frame) is built and verified**, S2–S21 are drafts waiting for the loop above.
- CLI, MCP server (34 tools), Claude Code plugin, Go agent, installer, docs site, CI: done for v0.1.
- Brand: logo and banners in `../brand/`. The founder is still choosing between 20 marks (see `images/logo-grid-20.png`); #1 "ribbed D" is in use meanwhile.

## Ground rules that never change

- Free forever. No paid tier, no telemetry, no hosted cloud.
- Grayscale UI. Color only for status. No gradients, glows, blue, violet.
- One screen at a time. Nothing is approved without QA's pass and the-user's OK.
- `CONTRACT.md` wins over code. `apps/web/DESIGN.md` wins over taste.
- Don't add dependencies without asking the founder.
