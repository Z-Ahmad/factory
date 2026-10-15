// Helpers for tests that need something listening on a port. Servers run as separate processes,
// so a command that kills or inspects them can never hit the test runner itself.
import { spawn } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';

/** A TCP port nothing is listening on right now. */
export function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer().listen(0, '127.0.0.1');
    s.once('error', fail);
    s.once('listening', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** True when something accepts a TCP connection on the port. */
export function isUp(port) {
  return new Promise((ok) => {
    const c = connect({ port, host: '127.0.0.1' });
    c.once('connect', () => { c.destroy(); ok(true); });
    c.once('error', () => ok(false));
  });
}

export async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Writes dir/server.mjs: listens on the port in argv[2], else $PORT. */
export function writeServer(dir) {
  const file = join(dir, 'server.mjs');
  writeFileSync(
    file,
    `import { createServer } from 'node:net';
createServer().listen(Number(process.argv[2] ?? process.env.PORT), '127.0.0.1');
`,
  );
  chmodSync(file, 0o644);
  return file;
}

/** Starts a server on the port as its own process; resolves once it is listening. */
export async function startServer(dir, port) {
  const child = spawn(process.execPath, [writeServer(dir), String(port)], { stdio: 'ignore' });
  if (!(await waitFor(() => isUp(port)))) throw new Error(`server did not start on :${port}`);
  return child;
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
