// Snapshot pool lifecycle — manages a pool of warm CLH VM slots.
//
// On startup: boots a template VM, pauses it, takes a golden snapshot,
// then copies it to N slot directories.
//
// On each /exec request: picks an idle slot, restores from snapshot,
// hotplugs virtiofs (nix store + daemon socket), resumes, runs command, destroys,
// and refills the slot from the golden snapshot.

import { mkdir, rm, cp } from "node:fs/promises";
import { log } from "../shared/kube.js";
import { VmInstance, type VmConfig, type ExecRequest, type ExecResult } from "./vm.js";

const COMPONENT = "pool-manager";

/** Path to the host nix store. */
const NIX_STORE_PATH = "/nix/store";
/** Path to the host nix-daemon socket directory. */
const NIX_DAEMON_DIR = "/nix/var/nix/daemon-socket";

type SlotState = "idle" | "busy" | "restoring";

interface Slot {
  id: string;
  dir: string;
  state: SlotState;
  vm: VmInstance | null;
}

export interface PoolConfig extends VmConfig {
  poolSize: number;
}

export interface PoolStatus {
  idle: number;
  busy: number;
  total: number;
  ready: boolean;
}

export class Pool {
  private goldenDir: string;
  private slots: Slot[] = [];
  private config: PoolConfig;
  private ready = false;
  private waiters: (() => void)[] = [];

  constructor(config: PoolConfig) {
    this.config = config;
    this.goldenDir = `${config.workDir}/golden`;

    for (let i = 0; i < config.poolSize; i++) {
      this.slots.push({
        id: `slot-${i}`,
        dir: `${config.workDir}/slot-${i}`,
        state: "idle",
        vm: null,
      });
    }
  }

  /**
   * Initialize the pool: boot template, snapshot, populate slots.
   */
  async start(): Promise<void> {
    log(COMPONENT, `starting pool (size=${this.config.poolSize})`);

    // Clean previous state
    await rm(this.goldenDir, { recursive: true, force: true });
    for (const slot of this.slots) {
      await rm(slot.dir, { recursive: true, force: true });
    }

    // 1. Boot template VM (no virtiofs)
    const template = new VmInstance(this.config, "template");
    try {
      await template.bootTemplate();

      // 2. Pause template
      await template.pause();

      // 3. Snapshot to golden directory
      await template.snapshot(this.goldenDir);
    } finally {
      // 4. Kill template VM
      template.destroy();
    }

    // Clean template work directory
    await rm(`${this.config.workDir}/template`, { recursive: true, force: true });

    // 5. Copy golden snapshot to each slot
    for (const slot of this.slots) {
      await this.refillSlot(slot);
    }

    this.ready = true;
    log(COMPONENT, `pool ready (${this.config.poolSize} slots)`);

    // Wake any waiters
    for (const resolve of this.waiters) {
      resolve();
    }
    this.waiters = [];
  }

  /**
   * Execute a command in a pool VM.
   * Picks an idle slot, restores, runs command, destroys, refills.
   */
  async exec(request: ExecRequest): Promise<ExecResult> {
    // Wait for an idle slot
    const slot = await this.acquireSlot();

    try {
      // 1. Start virtiofsd for nix store
      const vm = new VmInstance(this.config, slot.id);
      slot.vm = vm;

      const nixStoreSocket = await vm.startVirtiofsd("nixstore", NIX_STORE_PATH);

      // Also share nix-daemon socket directory via virtiofs
      const nixDaemonFsSocket = await vm.startVirtiofsd("nixdaemon", NIX_DAEMON_DIR);

      // 2. Restore CLH from slot's snapshot copy
      await vm.restoreFromSnapshot(slot.dir);

      // 3. Hotplug virtiofs devices
      await vm.addFs("nixstore", nixStoreSocket);
      await vm.addFs("nixdaemon", nixDaemonFsSocket);

      // 4. Resume VM — guest phase 2 will mount virtiofs
      await vm.resume();

      // 5. Execute command via vsock
      const result = await vm.exec(request);

      return result;
    } finally {
      // 6. Destroy VM
      if (slot.vm) {
        slot.vm.destroy();
        slot.vm = null;
      }

      // 7. Refill slot from golden snapshot (async, don't block response)
      this.refillSlotAsync(slot);
    }
  }

  /**
   * Get pool status.
   */
  status(): PoolStatus {
    return {
      idle: this.slots.filter((s) => s.state === "idle").length,
      busy: this.slots.filter((s) => s.state === "busy").length,
      total: this.slots.length,
      ready: this.ready,
    };
  }

  /**
   * Destroy all active VMs and clean up.
   */
  async stop(): Promise<void> {
    log(COMPONENT, "stopping pool");
    for (const slot of this.slots) {
      if (slot.vm) {
        slot.vm.destroy();
        slot.vm = null;
      }
    }
    this.ready = false;
  }

  /** Acquire an idle slot, waiting if necessary. */
  private async acquireSlot(): Promise<Slot> {
    while (true) {
      const slot = this.slots.find((s) => s.state === "idle");
      if (slot) {
        slot.state = "busy";
        log(COMPONENT, `acquired ${slot.id}`, slot.id);
        return slot;
      }

      // Wait for a slot to become available
      log(COMPONENT, "all slots busy, waiting...");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  /** Copy golden snapshot to slot directory. */
  private async refillSlot(slot: Slot): Promise<void> {
    slot.state = "restoring";
    await rm(slot.dir, { recursive: true, force: true });
    await cp(this.goldenDir, slot.dir, { recursive: true });
    slot.state = "idle";
    log(COMPONENT, `slot refilled from golden snapshot`, slot.id);

    // Wake any waiters
    const waiter = this.waiters.shift();
    if (waiter) waiter();
  }

  /** Refill a slot asynchronously, logging errors. */
  private refillSlotAsync(slot: Slot): void {
    this.refillSlot(slot).catch((err) => {
      log(COMPONENT, `error refilling ${slot.id}: ${err}`);
      // Mark as idle anyway so the pool doesn't deadlock
      slot.state = "idle";
      const waiter = this.waiters.shift();
      if (waiter) waiter();
    });
  }
}
