import fs, { watch, type FSWatcher } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

/**
 * Detect file-system writes made by the in-process relay.
 *
 * Every write-capable fs API (callback, sync and promise flavours) is wrapped. A call
 * is attributed to the relay when the synchronous call stack contains a frame from
 * apps/relay/. syncBuiltinESMExports() pushes the wrappers into the live bindings of
 * `import { … } from 'node:fs'` in already-loaded ES modules (the relay's included).
 *
 * As a second, attribution-free check, a recursive fs.watch on the repository reports
 * any file created or changed outside node_modules/.git while the guard is armed.
 */

export interface WriteCall {
  fn: string;
  target: string;
  stack: string;
}

const WRITE_FNS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync',
  'rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'symlink', 'symlinkSync', 'link', 'linkSync',
  'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'truncate', 'truncateSync', 'createWriteStream',
  'open', 'openSync', 'utimes', 'utimesSync', 'chmod', 'chmodSync',
] as const;
const PROMISE_FNS = [
  'writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rename', 'copyFile', 'cp', 'symlink', 'link', 'unlink', 'rm', 'rmdir',
  'truncate', 'open', 'utimes', 'chmod',
] as const;

/** open() only writes with a write/append/create flag. */
function isWriteOpen(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'number') return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0;
  return /[wa+]/.test(String(flags));
}

export interface FsGuard {
  calls: WriteCall[];
  /**
   * Positive control: createReadStream calls (the relay serves the app with it). Seeing the
   * relay here proves the wrappers reach the relay's imports and that attribution works.
   */
  reads: WriteCall[];
  /** Calls whose stack goes through the relay's source. */
  relayCalls(): WriteCall[];
  /** Paths (relative to the repo) that changed on disk while armed, outside node_modules/.git. */
  repoChanges: string[];
  restore(): void;
}

export const fromRelay = (c: WriteCall) => c.stack.includes(`${path.sep}apps${path.sep}relay${path.sep}`);

export function armFsGuard(repoRoot: string): FsGuard {
  const calls: WriteCall[] = [];
  const reads: WriteCall[] = [];
  const originals: [object, string, unknown][] = [];

  const wrap = (obj: Record<string, unknown>, name: string, label: string) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    originals.push([obj, name, orig]);
    obj[name] = function (this: unknown, ...args: unknown[]) {
      if (!/^open/.test(name) || isWriteOpen(args[1])) {
        calls.push({ fn: label, target: String(args[0]), stack: new Error().stack ?? '' });
      }
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
  };
  const origRead = fs.createReadStream;
  originals.push([fs, 'createReadStream', origRead]);
  (fs as unknown as Record<string, unknown>).createReadStream = function (this: unknown, ...args: unknown[]) {
    reads.push({ fn: 'fs.createReadStream', target: String(args[0]), stack: new Error().stack ?? '' });
    return (origRead as (...a: unknown[]) => unknown).apply(this, args);
  };
  for (const n of WRITE_FNS) wrap(fs as unknown as Record<string, unknown>, n, `fs.${n}`);
  for (const n of PROMISE_FNS) wrap(fs.promises as unknown as Record<string, unknown>, n, `fs.promises.${n}`);
  syncBuiltinESMExports();

  const repoChanges: string[] = [];
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(repoRoot, { recursive: true }, (_event, file) => {
      if (!file) return;
      const f = String(file);
      if (/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(f)) return;
      repoChanges.push(f);
    });
  } catch {
    // recursive watch unsupported: the stack-attributed spy still applies
  }

  return {
    calls,
    reads,
    repoChanges,
    relayCalls: () => calls.filter(fromRelay),
    restore() {
      watcher?.close();
      for (const [obj, name, orig] of originals) (obj as Record<string, unknown>)[name] = orig;
      syncBuiltinESMExports();
    },
  };
}
