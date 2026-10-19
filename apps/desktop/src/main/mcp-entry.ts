// Entry for the stdio MCP server that coding agents spawn:
//   ELECTRON_RUN_AS_NODE=1 <electron> out/main/mcp.js --project <root> [--agent <id>]
// Must never write to stdout except MCP protocol frames.
import { startMcpServer } from '@atomic/core/mcp/index';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const root = arg('--project') ?? process.env.ATOMIC_PROJECT;
if (!root) {
  process.stderr.write('atomic-mcp: --project <root> is required\n');
  process.exit(2);
}

// stray logging from dependencies must not corrupt the protocol stream
console.log = console.info = console.debug = (...a: unknown[]) => { process.stderr.write(`${a.join(' ')}\n`); };

startMcpServer({ root, agentId: arg('--agent') }).catch((e: unknown) => {
  process.stderr.write(`atomic-mcp: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
