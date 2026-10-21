// Isolated, local-only storage for offline migration tools. Never loads Wrangler config.
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open, opendir, readdir, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RECEIPT = 'migration_receipt';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export class MigrationError extends Error {
  constructor(code) { super(code); this.name = 'MigrationError'; this.code = code; }
}
export function check(condition, code) { if (!condition) throw new MigrationError(code); }
export function safeCode(error) { return error instanceof MigrationError ? error.code : 'LOCAL_OPERATION_FAILED'; }

// Reject symlinks/junctions in every existing path component, including the leaf.
export async function noLinks(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { check(!(await lstat(current)).isSymbolicLink(), 'PATH_SYMLINK'); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return absolute;
}
export const canonicalPath = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
export async function persistencePath(value) {
  check(typeof value === 'string' && path.isAbsolute(value), 'PERSIST_ABSOLUTE_REQUIRED');
  const absolute = await noLinks(value), canonical = canonicalPath(absolute);
  const relative = path.relative(canonicalPath(ROOT), canonical);
  check(canonical !== canonicalPath(path.parse(absolute).root) && relative !== '' && canonical !== canonicalPath(process.cwd()), 'PERSIST_DEDICATED_REQUIRED');
  check(!canonical.split(path.sep).some((part) => part.toLowerCase() === '.wrangler'), 'PERSIST_DEDICATED_REQUIRED');
  const fromTarget = path.relative(canonical, canonicalPath(ROOT));
  check(fromTarget === '..' || fromTarget.startsWith(`..${path.sep}`) || path.isAbsolute(fromTarget), 'PERSIST_DEDICATED_REQUIRED');
  return absolute;
}

export async function inspectPersistTree(root, { maxNodes = 10000, maxBytes = 10 * 1024 ** 3 } = {}) {
  const queue = [root]; let nodes = 0, bytes = 0;
  while (queue.length) {
    const target = queue.pop();
    let stat;
    try { stat = await lstat(target); } catch (error) { if (error.code === 'ENOENT' && target === root) return; throw error; }
    check(++nodes <= maxNodes, 'PERSIST_TREE_LIMIT');
    check(!stat.isSymbolicLink(), 'PERSIST_SYMLINK');
    check(stat.isDirectory() || stat.isFile(), 'PERSIST_SPECIAL_FILE');
    if (stat.isFile()) { bytes += stat.size; check(bytes <= maxBytes, 'PERSIST_TREE_LIMIT'); }
    else {
      const directory = await opendir(target);
      try {
        for await (const entry of directory) {
          check(nodes + queue.length + 1 <= maxNodes, 'PERSIST_TREE_LIMIT');
          queue.push(path.join(target, entry.name));
        }
      } finally { await directory.close().catch((error) => { if (error.code !== 'ERR_DIR_CLOSED') throw error; }); }
    }
  }
}

// Read-only ACL verification. No ACL grants, inheritance changes, or shell interpolation.
const ACL_SCRIPT = "$ErrorActionPreference='Stop'; try { $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $a=Get-Acl -LiteralPath $env:SIKAP_MIGRATION_ACL_PATH; $owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; if($owner -ne $me){exit 2}; foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @($me,'S-1-5-18','S-1-5-32-544')) {exit 2} }; exit 0 } catch {exit 2}";
export async function verifyPrivatePersistence(persist) {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ACL_SCRIPT, 'utf16le').toString('base64')], {
      shell: false, windowsHide: true, timeout: 10000, encoding: 'utf8', maxBuffer: 4096,
      env: { ...process.env, SIKAP_MIGRATION_ACL_PATH: persist },
    });
    check(!result.error && result.status === 0, 'PERSIST_PERMISSIONS');
  } else {
    const stat = await lstat(persist);
    check(stat.uid === process.getuid(), 'PERSIST_PERMISSIONS');
    await chmod(persist, 0o700);
    check(((await lstat(persist)).mode & 0o777) === 0o700, 'PERSIST_PERMISSIONS');
  }
}

export async function readBoundedHandle(handle, maxBytes) {
  const stat = await handle.stat();
  check(stat.isFile() && stat.size <= maxBytes, 'PLAN_SIZE');
  const chunks = []; let size = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - size));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (!bytesRead) break;
    size += bytesRead; check(size <= maxBytes, 'PLAN_SIZE');
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, size);
}
export async function readBoundedPlan(target, maxBytes) {
  const absolute = await noLinks(target);
  check((await lstat(absolute)).isFile(), 'PLAN_SIZE');
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try { const bytes = await readBoundedHandle(handle, maxBytes); await noLinks(absolute); return bytes; }
  finally { await handle.close(); }
}

// Repository migrations only. A small lexer preserves quoted semicolons and removes comments.
export function splitMigration(sql) {
  const statements = [];
  let buffer = '', quote = '', line = false, block = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i], next = sql[i + 1];
    if (line) { if (char === '\n') { line = false; buffer += ' '; } continue; }
    if (block) { if (char === '*' && next === '/') { block = false; i++; buffer += ' '; } continue; }
    if (quote) {
      buffer += char;
      if (char === quote) { if (next === quote) { buffer += next; i++; } else quote = ''; }
      continue;
    }
    if (char === '-' && next === '-') { line = true; i++; continue; }
    if (char === '/' && next === '*') { block = true; i++; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; buffer += char; continue; }
    if (char === ';') { if (buffer.trim()) statements.push(buffer.trim()); buffer = ''; }
    else buffer += char;
  }
  check(!quote && !block, 'LOCAL_SCHEMA_INVALID');
  if (buffer.trim()) statements.push(buffer.trim());
  return statements;
}

export async function openLocalStore(persistTo, { initialize = true } = {}) {
  const persist = await persistencePath(persistTo);
  await inspectPersistTree(persist);
  if (!initialize) {
    try { check((await lstat(path.join(persist, 'd1'))).isDirectory(), 'LOCAL_STORE_MISSING'); }
    catch (error) { if (error.code === 'ENOENT') throw new MigrationError('LOCAL_STORE_MISSING'); throw error; }
  }
  await mkdir(persist, { recursive: true, mode: 0o700 });
  await noLinks(persist);
  await verifyPrivatePersistence(persist);
  await inspectPersistTree(persist);
  const identity = sha256(canonicalPath(await realpath(persist)));
  let Miniflare, Log, LogLevel, convertV4MiniflareOptions;
  try { ({ Miniflare, Log, LogLevel, convertV4MiniflareOptions } = await import('miniflare')); }
  catch { throw new MigrationError('MINIFLARE_DEPENDENCY_REQUIRED'); }
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: '2026-10-01', host: '127.0.0.1', port: 0,
    script: 'export default { fetch() { return new Response(null, { status: 404 }); } };',
    // Block all worker-originated egress. No HTTP listener is requested by these tools.
    outboundService: () => new Response(null, { status: 403 }),
    log: new Log(LogLevel.NONE),
    cf: false, telemetry: { enabled: false },
    resourcePersistencePath: persist, isolatedResourcePersistencePath: persist,
    d1Databases: { DB: 'sikap-migration-local' },
    r2Buckets: { FILES: 'sikap-migration-local-files' },
  }));
  try {
    const db = await mf.getD1Database('DB');
    const bucket = await mf.getR2Bucket('FILES');
    if (initialize) {
      await db.prepare('CREATE TABLE IF NOT EXISTS migration_schema (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)').run();
      const names = (await readdir(path.join(ROOT, 'migrations'))).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
      for (const name of names) {
        const bytes = await readFile(path.join(ROOT, 'migrations', name));
        const digest = sha256(bytes);
        const applied = await db.prepare('SELECT sha256 FROM migration_schema WHERE name = ?').bind(name).first();
        if (applied) { check(applied.sha256 === digest, 'LOCAL_SCHEMA_CHANGED'); continue; }
        await db.batch([
          ...splitMigration(bytes.toString('utf8')).map((sql) => db.prepare(sql)),
          db.prepare('INSERT INTO migration_schema (name, sha256) VALUES (?, ?)').bind(name, digest),
        ]);
      }
      await db.prepare(`CREATE TABLE IF NOT EXISTS migration_receipt (
        id INTEGER PRIMARY KEY CHECK (id = 1), snapshot_id TEXT NOT NULL,
        source_sha256 TEXT NOT NULL, plan_sha256 TEXT NOT NULL, persist_identity TEXT NOT NULL,
        stage INTEGER NOT NULL CHECK (stage >= 0 AND stage <= 7),
        cursor INTEGER NOT NULL CHECK (cursor >= 0), counts_json TEXT NOT NULL,
        complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1))
      )`).run();
    }
    return { db, bucket, persist, identity, close: () => mf.dispose() };
  } catch (error) { await mf.dispose(); throw error; }
}

export function parseArgs(argv, { reconcile = false } = {}) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--plan', '--files', '--persist-to'].includes(arg)) {
      check(!Object.hasOwn(options, arg.slice(2)) && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--'), 'CLI_ARGUMENTS');
      options[arg.slice(2)] = argv[++i];
    } else if (!reconcile && (arg === '--apply' || arg === '--dry-run')) {
      check(!options.apply && !options.dryRun, 'CLI_ARGUMENTS');
      if (arg === '--apply') options.apply = true; else options.dryRun = true;
    } else throw new MigrationError('CLI_ARGUMENTS');
  }
  check(options.plan && options.files && options['persist-to'], 'CLI_ARGUMENTS');
  return { planPath: options.plan, filesDir: options.files, persistTo: options['persist-to'], apply: options.apply === true };
}
export function isMain(url) { return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url); }
