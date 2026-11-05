/** 404 inside the app shell. Plain. */
import { Link, useLocation } from 'react-router';
import { Button } from '../components/ui.tsx';

export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="mx-auto max-w-[1400px] py-16">
      <div className="text-sm tabular-nums text-muted">404</div>
      <h1 className="mt-1 text-xl font-semibold">Page not found</h1>
      <p className="mt-2 max-w-lg text-sm text-muted">
        There is no page at <code className="break-all font-mono text-xs text-fg">{pathname}</code>. It may have moved, or the link is mistyped.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Link to="/"><Button variant="primary">Go to Overview</Button></Link>
        <Button variant="secondary" onClick={() => window.history.back()}>Go back</Button>
      </div>
    </div>
  );
}
