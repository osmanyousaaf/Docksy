import { createContext } from './context.ts';
import { run } from './program.ts';

// Exit quietly when output is piped into something that closes early (`docksy logs app | head`).
process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); });

const argv = process.argv.slice(2);
const code = await run(argv, createContext());
// `docksy mcp` keeps running (the MCP server owns the event loop); everything else exits with its code.
if (argv[0] !== 'mcp' || code !== 0) process.exitCode = code;
