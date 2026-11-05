# Docksy UI design guide: formal black & gray

The founder rejected the first UI (navy blue, bright blue/violet, gradients, glowing gauges, too many cards). The new look is **simple, formal and flat, like Coolify**. Reference screenshot (look at it first):
`/private/tmp/claude-501/-Users-appleenterprises-Desktop-REA-Coolify/7dd870f6-55a1-42f1-91d8-ff23527e4314/images/1.png`

## Rules

1. **Grayscale only.** Use the tokens in `src/index.css`:
   - `bg-bg` (#0a0a0a page)
   - `bg-surface` (#121212 panels/inputs/sidebar)
   - `bg-surface-2` (hover/active)
   - `bg-surface-3`
   - `border-border`, `border-border-strong`
   - `text-fg`, `text-muted`, `text-faint`

   Color appears **only** for status: `text-ok`/`bg-ok` (green), `warn` (yellow) and `bad` (red), as small dots or short status text. Never use colored backgrounds, colored icons or tinted panels.
2. **Never use:**
   - gradients (`bg-gradient-*`, `from-*`, `to-*`)
   - glows, shadows (`shadow-*`), `backdrop-blur`, radial or animated decorations
   - pulsing dots (a single small "live" dot is OK, but don't animate it)
   - colored icon tiles
   - violet or blue accents
   - `text-brand-2`, `bg-brand/10` and similar brand tints

   `text-brand` is now just white, so prefer `text-fg`.
3. **Flat structure.** Use fewer cards. Configuration screens are **forms on the page background**, not cards. Use cards (`Card`) only for genuine grouped data such as tables, charts and metric tiles.
4. **Typography.** 14px base. Page title `text-xl font-semibold`. Section title `text-lg font-semibold` with the Save button right next to it (Coolify's "General [Save]"). Labels are `text-sm text-fg`, with a red `*` when required. Help text is `text-xs text-muted`.
5. **Controls.** Use `components/ui.tsx`:
   - `Button`: `primary` = white with black text, used once per view; `secondary` = gray; `danger` = gray with red text; `ghost`
   - `Input`, `Select`, `Textarea`, `Checkbox`, `Field`, `FieldGrid`, `Section`, `SubNavLayout`, `PageTabs`, `Breadcrumbs`, `Status`, `StatusDot`, `Badge`, `Table`, `Callout`, `Meter`
   - Radius is `rounded-md` (6px). Buttons are h-8; inputs are h-9.
6. **Icons.** lucide-react at `size-4`, in `text-muted` (or inheriting the text color). They are optional and never decorative-colored. A button may carry a small icon (Coolify's Redeploy/Stop do).
7. **Charts.** Monochrome: CPU `#e5e5e5`, memory `#a3a3a3`, disk `#737373`, net rx `#d4d4d4`, net tx `#737373` (CSS vars `--color-cpu` etc.).
   - thin 1.5px lines
   - no gradient fills (a flat `fillOpacity` ≤ 0.08 is the most allowed)
   - gridlines `#1f1f1f`, axis text `#5c5c5c` at 11px
   - threshold lines dashed `#333`
   - no radial gauges with glow; use plain big numbers plus a thin `Meter` bar
8. **Status.**
   - Running: `<Status status="running" />` renders "● Running" in green text.
   - Failed: red.
   - Deploying: yellow.
   - Stopped/idle: gray.
9. **Density.** Calm and aligned. `max-w-[1400px]` content, 24–32px page padding, generous vertical rhythm between sections (`mb-10`), and tables with thin row borders.
10. **Motion.** Minimal: 150ms color transitions only. Respect `prefers-reduced-motion`.
11. **Copy.** Short, formal, helpful. Each section gets a one-line description, as in Coolify ("General configuration for your application.").
12. **Single theme.** Dark only. The light theme and the theme toggle are removed.

## Page anatomy (Coolify-style)

```
Breadcrumbs:  Apps › e2e-vps › my-app   ● Running
PageTabs:     Configuration  Deployments  Logs  Terminal  Metrics          [↻ Redeploy] [■ Stop]
──────────────────────────────────────────────────────────────────────────────────────────────
SubNav        │ General [Save]
 General      │ General configuration for your application.
 Environment  │ Name *                         Description
 Storage      │ [_____________]                [_____________]
 Source       │ Build Pack *
 Limits       │ [Dockerfile ▾]
 Health check │ Domains
 Webhooks     │ [https://app.1.2.3.4.sslip.io           ] [Generate Domain]
 Backups      │ Build
 Danger Zone  │ Base Directory      Dockerfile Location ...
```

## Verifying your work (required)

The demo backend is live at `http://127.0.0.1:8080`, with real data: one server with live metrics and one deployed app. Login: `e2e@docksy.local` / `e2e-correct-horse-battery`.

- Run Vite on your own port against it:
  `cd apps/web && DOCKSY_API=http://127.0.0.1:8080 npx vite --port <yourPort> --strictPort`
- Screenshot pages (headless Chrome, logs in for you):
  `DOCKSY_URL=http://localhost:<yourPort> DOCKSY_EMAIL=e2e@docksy.local DOCKSY_PASSWORD=e2e-correct-horse-battery node scripts/shot.mjs <outDir> /path1 /path2`
  Add `SHOT_FULL=1` for full-page shots and `SHOT_WIDTH=390` for mobile.
- **Look at your screenshots with the Read tool** and compare them to the Coolify reference. Iterate until it looks formal, aligned and complete.
- `npm run build -w @docksy/web` must pass. Never stop or restart the server on :8080 (others use it). Don't write to its data destructively: no deleting the server or app, and no changing the owner password.
