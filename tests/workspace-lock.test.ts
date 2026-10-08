import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { withWorkspaceLock, workspaceDataDirectory } from "@/lib/workspace-lock";

let root: string;
let previousDirectory: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workspace-lock-test-"));
  previousDirectory = process.env.WORKSPACE_DATA_DIR;
  process.env.WORKSPACE_DATA_DIR = root;
});
afterEach(async () => {
  if (previousDirectory === undefined) delete process.env.WORKSPACE_DATA_DIR;
  else process.env.WORKSPACE_DATA_DIR = previousDirectory;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const lockPath = () => path.join(root, ".workspace.lock");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
  const pid = child.pid!;
  await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
  return pid;
}

describe("shared workspace lock", () => {
  it("resolves the configured storage root", () => {
    expect(workspaceDataDirectory()).toBe(path.resolve(root));
  });
  it("serializes concurrent mutations and removes all temporary lock files", async () => {
    let active = 0;
    const order: number[] = [];
    await Promise.all(Array.from({ length: 12 }, (_, i) => withWorkspaceLock(async () => {
      expect(++active).toBe(1);
      order.push(i);
      await sleep(2);
      active--;
    })));
    expect(order).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(await readdir(root)).toEqual([]);
  });
  it("allows nested calls for the same absolute storage root", async () => {
    const result = await withWorkspaceLock(async () => {
      const owner = await readFile(lockPath(), "utf8");
      return withWorkspaceLock(async () => {
        expect(await readFile(lockPath(), "utf8")).toBe(owner);
        return 42;
      }, path.join(root, "."));
    });
    expect(result).toBe(42);
    expect(await readdir(root)).toEqual([]);
  });
  it("does not let a callback inherit reentrant privileges after the owner releases", async () => {
    let runLater!: () => void;
    let later!: Promise<void>;
    await withWorkspaceLock(async () => {
      later = new Promise<void>(resolve => { runLater = resolve; }).then(() => withWorkspaceLock(async () => {
        // A genuinely reacquired lock must exist during the delayed callback.
        expect(await readFile(lockPath(), "utf8")).toContain('"pid"');
      }));
    });
    expect(await readdir(root)).toEqual([]);
    runLater();
    await later;
    expect(await readdir(root)).toEqual([]);
  });
  it("allows an independent directory to progress while another is locked", async () => {
    const second = path.join(root, "second");
    await withWorkspaceLock(async () => {
      await withWorkspaceLock(async () => {
        expect(await readFile(lockPath(), "utf8")).toContain('"pid"');
      }, second);
    });
    expect(await readdir(second)).toEqual([]);
  });
  it("waits for a live external owner without stealing its lock", async () => {
    const owner = { pid: process.pid, token: randomUUID() };
    await writeFile(lockPath(), JSON.stringify(owner));
    const entered = vi.fn();
    const waiting = withWorkspaceLock(async () => entered());
    await sleep(150);
    expect(entered).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(lockPath(), "utf8"))).toEqual(owner);
    await rm(lockPath());
    await waiting;
    expect(entered).toHaveBeenCalledTimes(1);
  });
  it("stops waiting at its deadline and preserves a live owner's file", async () => {
    const owner = { pid: process.pid, token: randomUUID() };
    await writeFile(lockPath(), JSON.stringify(owner));
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const waiting = expect(withWorkspaceLock(async () => {})).rejects.toThrow("busy");
    await sleep(150);
    now += 15001;
    await waiting;
    expect(JSON.parse(await readFile(lockPath(), "utf8"))).toEqual(owner);
    expect(await readdir(root)).toEqual([".workspace.lock"]);
  });
  it("recovers an owner whose process has exited", async () => {
    await writeFile(lockPath(), JSON.stringify({ pid: await exitedPid(), token: randomUUID() }));
    expect(await withWorkspaceLock(async () => "recovered")).toBe("recovered");
    expect(await readdir(root)).toEqual([]);
  });
  it.each(["", "not json", '{"pid":0,"token":"invalid"}', '{"pid":123}'])("fails closed for invalid owner %s", async raw => {
    await writeFile(lockPath(), raw);
    const entered = vi.fn();
    await expect(withWorkspaceLock(async () => entered())).rejects.toThrow(/unreadable owner|invalid lock owner/);
    expect(entered).not.toHaveBeenCalled();
    expect(await readFile(lockPath(), "utf8")).toBe(raw);
    expect(await readdir(root)).toEqual([".workspace.lock"]);
  });
  it("fails closed for an orphaned recovery gate", async () => {
    const old = { pid: await exitedPid(), token: randomUUID() };
    await writeFile(lockPath(), JSON.stringify(old));
    await writeFile(`${lockPath()}.recovery-${old.token}`, "interrupted recovery");
    await expect(withWorkspaceLock(async () => {})).rejects.toThrow("recovery");
    expect(JSON.parse(await readFile(lockPath(), "utf8"))).toEqual(old);
  });
  it("does not unlink a replacement owner's lock when releasing", async () => {
    const replacement = { pid: process.pid, token: randomUUID() };
    await withWorkspaceLock(async () => { await writeFile(lockPath(), JSON.stringify(replacement)); });
    expect(JSON.parse(await readFile(lockPath(), "utf8"))).toEqual(replacement);
  });
  it("releases the lock and queue after a mutation fails", async () => {
    await expect(withWorkspaceLock(async () => { throw new Error("failed mutation"); })).rejects.toThrow("failed mutation");
    expect(await withWorkspaceLock(async () => "next")).toBe("next");
    expect(await readdir(root)).toEqual([]);
  });
});
