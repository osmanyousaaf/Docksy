/**
 * Small utility classes the Tailwind defaults don't cover. index.css is integrator-owned,
 * so these are injected once at runtime.
 *
 * The UI is flat and calm (apps/web/DESIGN.md): the legacy entrance/glow/shimmer classes are kept
 * as harmless no-ops so older markup keeps working, but they no longer animate or decorate.
 * Only the terminal caret blinks, and it stops under prefers-reduced-motion.
 */
const CSS = `
@keyframes dx-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
.dx-fade-up, .dx-fade-in, .dx-pop, .dx-slide-in, .dx-glow { animation: none; }
.dx-caret { animation: dx-blink 1s step-end infinite; }
.dx-skeleton { background: var(--color-surface-2); }
.dx-grid-bg { background-image: none; }
.dx-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.dx-scroll::-webkit-scrollbar-thumb { background: var(--color-border-strong); border-radius: 8px; }
.dx-scroll::-webkit-scrollbar-track { background: transparent; }
@media (prefers-reduced-motion: reduce) {
  .dx-caret { animation: none !important; }
  .dx-motion, .dx-motion * { transition: none !important; }
}
`;

let injected = false;
export function ensureMonitoringStyles(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const el = document.createElement('style');
  el.dataset.docksy = 'monitoring';
  el.textContent = CSS;
  document.head.appendChild(el);
}
