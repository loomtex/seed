// swtpm process lifecycle management.
// Manages swtpm child processes on the host, one per SeedHostTask instance.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, access, constants } from "node:fs/promises";
import { log, waitFor } from "../shared/kube.js";

const COMPONENT = "host-agent";
const SWTPM_BIN = "/usr/bin/swtpm";
const STATE_BASE = "/var/lib/seed-controller/tpm";
const SOCKET_BASE = "/run/swtpm";

interface ManagedSwtpm {
  process: ChildProcess;
  socketPath: string;
  stateDir: string;
  socketDir: string;
}

/** Active swtpm processes keyed by "<namespace>-<instance>". */
const managed = new Map<string, ManagedSwtpm>();

function taskKey(ns: string, instance: string): string {
  return `${ns}-${instance}`;
}

/**
 * Ensure swtpm is running for an instance.
 * Returns the socket path on success, null on failure.
 */
export async function ensureSwtpm(
  ns: string,
  instance: string,
): Promise<string | null> {
  const key = taskKey(ns, instance);
  const stateDir = `${STATE_BASE}/${key}`;
  const socketDir = `${SOCKET_BASE}/${key}`;
  const socketPath = `${socketDir}/swtpm-sock`;

  // Already managed and alive?
  const existing = managed.get(key);
  if (existing && !existing.process.killed && existing.process.exitCode === null) {
    // Check socket exists
    try {
      await access(socketPath, constants.F_OK);
      return socketPath;
    } catch {
      // Process alive but socket gone — kill and restart
      log(COMPONENT, `swtpm alive but socket missing, restarting`, instance);
      killProcess(existing);
      managed.delete(key);
    }
  }

  // Ensure directories
  await mkdir(stateDir, { recursive: true });
  await mkdir(socketDir, { recursive: true });

  // Clean stale socket
  try {
    await rm(socketPath, { force: true });
  } catch {
    // ignore
  }

  log(COMPONENT, `starting swtpm (state=${stateDir} socket=${socketPath})`, instance);

  const child = spawn(SWTPM_BIN, [
    "socket",
    "--tpmstate", `dir=${stateDir}`,
    "--ctrl", `type=unixio,path=${socketPath}`,
    "--flags", "startup-clear",
    "--tpm2",
    "--log", "level=0",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // Log stderr for debugging
  child.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) log(COMPONENT, `swtpm stderr: ${msg}`, instance);
  });

  child.on("error", (err) => {
    log(COMPONENT, `swtpm process error: ${err.message}`, instance);
  });

  child.on("exit", (code, signal) => {
    log(COMPONENT, `swtpm exited (code=${code} signal=${signal})`, instance);
    managed.delete(key);
  });

  managed.set(key, { process: child, socketPath, stateDir, socketDir });

  // Wait for socket to appear (up to 10s)
  const ready = await waitFor(
    async () => {
      try {
        await access(socketPath, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    500,
    10_000,
  );

  if (!ready) {
    log(COMPONENT, `swtpm socket not ready after 10s`, instance);
    killProcess(managed.get(key)!);
    managed.delete(key);
    return null;
  }

  log(COMPONENT, `swtpm running (pid=${child.pid})`, instance);
  return socketPath;
}

/**
 * Stop swtpm for an instance.
 * Kills the process and removes the socket directory.
 * State directory is preserved for TPM state persistence.
 */
export async function stopSwtpm(ns: string, instance: string): Promise<void> {
  const key = taskKey(ns, instance);
  const entry = managed.get(key);
  if (entry) {
    log(COMPONENT, `stopping swtpm (pid=${entry.process.pid})`, instance);
    killProcess(entry);
    managed.delete(key);
  }

  // Clean socket dir (ephemeral), preserve state dir (persistent)
  const socketDir = `${SOCKET_BASE}/${key}`;
  try {
    await rm(socketDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** Kill all managed swtpm processes (for graceful shutdown). */
export function stopAll(): void {
  for (const [key, entry] of managed) {
    log(COMPONENT, `shutdown: killing swtpm (pid=${entry.process.pid})`, key);
    killProcess(entry);
  }
  managed.clear();
}

/** Get the number of actively managed swtpm processes. */
export function managedCount(): number {
  return managed.size;
}

function killProcess(entry: ManagedSwtpm): void {
  try {
    entry.process.kill("SIGTERM");
  } catch {
    // Process may have already exited
  }
}
