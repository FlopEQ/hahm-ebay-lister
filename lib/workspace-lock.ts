import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

const owners = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();
const queues = new Map<string, Promise<void>>();
const WAIT_MS = 15_000;
const POLL_MS = 100;
const LOCK_NAME = ".workspace.lock";
type Owner = { pid: number; token: string };

export function workspaceDataDirectory(): string {
  return path.resolve(process.env.WORKSPACE_DATA_DIR || path.join(process.cwd(), "data"));
}
async function readOwner(file: string): Promise<Owner | undefined> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Workspace storage is locked by an unreadable owner. Check the storage lock before retrying.");
  }
  const owner = raw as Owner;
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.token !== "string" || !/^[a-f0-9-]{36}$/.test(owner.token))
    throw new Error("Workspace storage has an invalid lock owner. Check the storage lock before retrying.");
  return owner;
}
function isDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
async function writeOwner(file: string, owner: Owner): Promise<void> {
  const output = await open(file, "wx", 0o600);
  try {
    try { await output.writeFile(JSON.stringify(owner)); await output.sync(); }
    finally { await output.close(); }
  } catch (error) {
    await unlink(file).catch(() => {});
    throw error;
  }
}
async function releaseOwned(file: string, owner: Owner): Promise<void> {
  const current = await readOwner(file);
  if (current?.token === owner.token && current.pid === owner.pid) await unlink(file);
}
async function recoverDeadOwner(file: string, observed: Owner): Promise<void> {
  const gate = `${file}.recovery-${observed.token}`;
  const recoveryOwner = { pid: process.pid, token: randomUUID() };
  try { await writeOwner(gate, recoveryOwner); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Workspace storage recovery is already in progress or was interrupted. Check the recovery lock before retrying.");
    throw error;
  }
  try {
    const current = await readOwner(file);
    if (current?.token === observed.token && current.pid === observed.pid && isDead(current.pid))
      await unlink(file);
  } finally { await releaseOwned(gate, recoveryOwner); }
}
async function acquire(root: string, deadline: number): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true });
  const file = path.join(root, LOCK_NAME);
  const owner = { pid: process.pid, token: randomUUID() };
  const candidate = `${file}.${owner.token}.tmp`;
  await writeOwner(candidate, owner);
  try {
    while (true) {
      if (Date.now() >= deadline)
        throw new Error("Workspace storage is busy. Wait for the current save or cleanup to finish and retry.");
      try {
        // Publishing a complete fsynced inode prevents empty owner records if
        // the process exits between acquiring the name and writing its content.
        await link(candidate, file);
        return () => releaseOwned(file, owner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const current = await readOwner(file);
      if (current && isDead(current.pid)) await recoverDeadOwner(file, current);
      else {
        if (Date.now() >= deadline)
          throw new Error("Workspace storage is busy. Wait for the current save or cleanup to finish and retry.");
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
      }
    }
  } finally { await unlink(candidate).catch(() => {}); }
}

export async function withWorkspaceLock<T>(run: () => Promise<T>, dataDir = workspaceDataDirectory()): Promise<T> {
  const root = path.resolve(dataDir);
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  if (owners.getStore()?.get(key)?.active) return run();
  const queuedAt = Date.now();
  const previous = queues.get(key) || Promise.resolve();
  let releaseQueue!: () => void;
  const next = new Promise<void>(resolve => { releaseQueue = resolve; });
  const tail = previous.then(() => next);
  queues.set(key, tail);
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([previous, new Promise<never>((_, reject) => {
      waitTimer = setTimeout(() => reject(new Error("Workspace storage is busy. Wait for the current save or cleanup to finish and retry.")), WAIT_MS);
    })]);
    if (waitTimer) clearTimeout(waitTimer);
    if (Date.now() - queuedAt >= WAIT_MS)
      throw new Error("Workspace storage is busy. Wait for the current save or cleanup to finish and retry.");
    const release = await acquire(root, queuedAt + WAIT_MS);
    const lease = { active: true };
    const inherited = new Map(owners.getStore() || []);
    inherited.set(key, lease);
    try { return await owners.run(inherited, run); }
    finally { lease.active = false; await release(); }
  } finally {
    if (waitTimer) clearTimeout(waitTimer);
    releaseQueue();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
