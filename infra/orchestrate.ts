import { execFileSync, execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import type { NodeConfig } from "./types.ts";
import {
  sshToAge,
  addNodeToSops,
  encryptSecrets,
  reencryptSecrets,
  updateLuksRecovery,
} from "./sops.ts";
import { createClevisJWE, generateLuksPassphrase } from "./clevis.ts";

interface SSHKeyPair {
  privateKey: string;
  publicKey: string;
}

interface ProvisionResult {
  luksPassphrase: string;
  agePublicKey: string;
}

// Generate an SSH key pair. Returns the key material as strings.
function generateSSHKeys(
  comment: string,
  type: "ed25519" | "rsa" = "ed25519"
): SSHKeyPair {
  const tmpDir = mkdtempSync(join(tmpdir(), "ssh-"));
  const keyPath = join(tmpDir, "key");

  const args = ["-t", type, "-C", comment, "-f", keyPath, "-N", ""];
  if (type === "rsa") {
    args.push("-b", "4096");
  }
  execFileSync("ssh-keygen", args, { stdio: "pipe" });

  const privateKey = execFileSync("cat", [keyPath], { encoding: "utf-8" });
  const publicKey = execFileSync("cat", [`${keyPath}.pub`], {
    encoding: "utf-8",
  });

  rmSync(tmpDir, { recursive: true });

  return { privateKey: privateKey.trim(), publicKey: publicKey.trim() };
}

// Wait for SSH to become available on a host.
// If sshProxy is set, tests connectivity through the proxy.
function waitForSSH(
  ip: string,
  { timeout = 600, port = 22, sshProxy }: { timeout?: number; port?: number; sshProxy?: string } = {}
): void {
  const deadline = Date.now() + timeout * 1000;
  const baseOpts = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=5",
  ];

  const sshArgs = sshProxy
    ? [...baseOpts, sshProxy, `ssh ${baseOpts.join(" ")} -p ${port} root@${ip} true`]
    : [...baseOpts, "-p", String(port), `root@${ip}`, "true"];

  while (Date.now() < deadline) {
    try {
      execFileSync("ssh", sshArgs, { stdio: "pipe", timeout: 15_000 });
      return;
    } catch {
      // Retry after a short delay
      execFileSync("sleep", ["5"]);
    }
  }
  throw new Error(`SSH to ${ip}:${port} not available after ${timeout}s`);
}

// Wait for SSH to go down (indicates reboot in progress).
function waitForSSHDown(
  ip: string,
  { timeout = 120 }: { timeout?: number } = {}
): void {
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    try {
      execFileSync(
        "ssh",
        [
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          "-o",
          "ConnectTimeout=3",
          `root@${ip}`,
          "true",
        ],
        { stdio: "pipe", timeout: 8_000 }
      );
      // Still up — wait and retry
      execFileSync("sleep", ["3"]);
    } catch {
      // SSH failed — host is going down
      return;
    }
  }
  pulumi.log.warn(`SSH to ${ip} did not go down within ${timeout}s`);
}

// Prepare the extra-files directory for nixos-anywhere.
// Layout matches mynix impermanence configuration:
//   /persist/etc/ssh/ssh_host_{ed25519,rsa}_key{,.pub}
//   /persist/secrets/initrd/ssh_host_ed25519_key{,.pub}
//   /persist/secrets/clevis-cryptroot.jwe
function prepareExtraFiles(args: {
  hostEd25519: SSHKeyPair;
  hostRsa: SSHKeyPair;
  initrdKey: SSHKeyPair;
  clevisJWE: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "extra-files-"));

  // Host SSH keys → /persist/etc/ssh/
  const sshDir = join(dir, "persist", "etc", "ssh");
  mkdirSync(sshDir, { recursive: true });
  writeFileSync(join(sshDir, "ssh_host_ed25519_key"), args.hostEd25519.privateKey + "\n", { mode: 0o600 });
  writeFileSync(join(sshDir, "ssh_host_ed25519_key.pub"), args.hostEd25519.publicKey + "\n", { mode: 0o644 });
  writeFileSync(join(sshDir, "ssh_host_rsa_key"), args.hostRsa.privateKey + "\n", { mode: 0o600 });
  writeFileSync(join(sshDir, "ssh_host_rsa_key.pub"), args.hostRsa.publicKey + "\n", { mode: 0o644 });

  // Initrd SSH key → /persist/secrets/initrd/
  const initrdDir = join(dir, "persist", "secrets", "initrd");
  mkdirSync(initrdDir, { recursive: true });
  writeFileSync(join(initrdDir, "ssh_host_ed25519_key"), args.initrdKey.privateKey + "\n", { mode: 0o600 });
  writeFileSync(join(initrdDir, "ssh_host_ed25519_key.pub"), args.initrdKey.publicKey + "\n", { mode: 0o644 });

  // Clevis JWE → /persist/secrets/
  const secretsDir = join(dir, "persist", "secrets");
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(join(secretsDir, "clevis-cryptroot.jwe"), args.clevisJWE + "\n", { mode: 0o600 });

  return dir;
}

// Verify node health after nixos-anywhere install + reboot.
function verifyNodeHealth(ip: string, label: string): void {
  const sshCmd = (cmd: string) =>
    execFileSync(
      "ssh",
      [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        `root@${ip}`,
        cmd,
      ],
      { encoding: "utf-8", timeout: 30_000 }
    ).trim();

  // Check hostname
  const hostname = sshCmd("hostname");
  if (hostname !== label) {
    pulumi.log.warn(`Expected hostname ${label}, got ${hostname}`);
  }

  // Check LUKS is active
  const luks = sshCmd("ls /dev/mapper/cryptroot 2>/dev/null && echo ok || echo missing");
  if (!luks.includes("ok")) {
    throw new Error(`LUKS device not active on ${label}`);
  }

  // Check SSH host key fingerprint
  const fingerprint = sshCmd(
    "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
  );
  pulumi.log.info(`${label} SSH fingerprint: ${fingerprint}`);
}

// Compute the /23 CIDR for an IPv4 address (Vultr bare metal subnets).
function ipToSubnet23(ip: string): string {
  const parts = ip.split(".").map(Number);
  // /23 means the third octet's LSB is masked out
  parts[2] = parts[2] & 0xfe;
  parts[3] = 0;
  return `${parts.join(".")}/23`;
}

// Add a node's subnet to the Tang allowlist (node-subnets.nix).
// Idempotent: skips if the subnet is already listed.
function addTangSubnet(mynixDir: string, ip: string, comment: string): void {
  const subnetsFile = join(mynixDir, "machines", "seed-tang-1", "node-subnets.nix");
  const content = readFileSync(subnetsFile, "utf-8");
  const subnet = ipToSubnet23(ip);

  if (content.includes(subnet)) {
    return; // Already listed
  }

  // Insert before the closing bracket
  const newLine = `  "${subnet}"   # ${comment}`;
  const updated = content.replace(/\n\]/, `\n${newLine}\n]`);
  writeFileSync(subnetsFile, updated);
}

// Fetch k3s token from a running cluster node.
function fetchK3sToken(ip: string): string {
  const token = execFileSync(
    "ssh",
    [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      `ada@${ip}`,
      "sudo cat /var/lib/rancher/k3s/server/token",
    ],
    { encoding: "utf-8", timeout: 15_000 }
  ).trim();
  if (!token.startsWith("K10")) {
    throw new Error(`Unexpected k3s token format from ${ip}: ${token.slice(0, 20)}...`);
  }
  return token;
}

// Generate a random k3s cluster token (for init node bootstrapping).
function generateK3sToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}

// Full provisioning workflow for a single node.
// Runs synchronously (called inside pulumi.output.apply).
export function provisionNode(
  ip: string,
  config: NodeConfig
): ProvisionResult {
  pulumi.log.info(`Provisioning ${config.name} at ${ip}...`);

  // Check if node is already provisioned and healthy — skip if so.
  // This makes the provisioner idempotent (safe to re-run after failures).
  try {
    verifyNodeHealth(ip, config.name);
    pulumi.log.info(`${config.name}: already provisioned and healthy, skipping`);
    const existingPubKey = execFileSync(
      "ssh",
      [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        `ada@${ip}`,
        "cat /etc/ssh/ssh_host_ed25519_key.pub",
      ],
      { encoding: "utf-8", timeout: 15_000 }
    ).trim();
    const agePublicKey = sshToAge(existingPubKey);
    return { luksPassphrase: "", agePublicKey };
  } catch {
    pulumi.log.info(`${config.name}: not yet provisioned, proceeding`);
  }

  // 0. Add node's subnet to Tang allowlist
  pulumi.log.info(`${config.name}: updating Tang allowlist with ${ip}`);
  addTangSubnet(config.mynixDir, ip, config.name);

  // 1. Generate SSH host keys
  pulumi.log.info(`${config.name}: generating SSH host keys`);
  const hostEd25519 = generateSSHKeys(`root@${config.name}`, "ed25519");
  const hostRsa = generateSSHKeys(`root@${config.name}`, "rsa");
  const initrdKey = generateSSHKeys(`initrd@${config.name}`, "ed25519");

  // 2. Derive age public key from ed25519 host key
  const agePublicKey = sshToAge(hostEd25519.publicKey);
  pulumi.log.info(`${config.name}: age key = ${agePublicKey}`);

  // 3. Update .sops.yaml with node's age key
  pulumi.log.info(`${config.name}: updating sops configuration`);
  const sopsYamlPath = join(config.mynixDir, ".sops.yaml");
  addNodeToSops(sopsYamlPath, config.name, agePublicKey);

  // 4. Get or generate k3s token + create per-node secrets file
  pulumi.log.info(`${config.name}: creating node secrets`);
  let k3sToken: string;
  if (config.clusterInit) {
    k3sToken = generateK3sToken();
    pulumi.log.info(`${config.name}: generated new k3s cluster token`);
  } else if (config.initNodeIp) {
    k3sToken = fetchK3sToken(config.initNodeIp);
    pulumi.log.info(`${config.name}: fetched k3s token from init node ${config.initNodeIp}`);
  } else {
    throw new Error(`${config.name}: joining node requires initNodeIp to fetch k3s token`);
  }
  encryptSecrets(config.mynixDir, `secrets/${config.name}.yaml`, {
    "seed/k3s-token": k3sToken,
  });

  // 5. Re-encrypt seed-system.yaml so the new node can decrypt shared secrets
  pulumi.log.info(`${config.name}: re-encrypting seed-system.yaml`);
  reencryptSecrets(config.mynixDir, "secrets/seed-system.yaml");

  // 6. Generate LUKS passphrase + Clevis JWE
  pulumi.log.info(`${config.name}: creating LUKS passphrase + Clevis JWE`);
  const luksPassphrase = generateLuksPassphrase();
  const clevisJWE = createClevisJWE(luksPassphrase, config.tangUrl, config.sshProxy);

  // 7. Store LUKS passphrase in sops-encrypted recovery file + commit all secrets
  pulumi.log.info(`${config.name}: storing LUKS recovery passphrase`);
  updateLuksRecovery(config.mynixDir, config.name, luksPassphrase);
  execSync(
    `cd ${shellQuote(config.mynixDir)} && git add .sops.yaml secrets/ machines/seed-tang-1/node-subnets.nix && git commit -m "infra: add secrets + sops config for ${config.name}" && git push`,
    { stdio: "pipe", timeout: 30_000 }
  );

  // 8. Prepare extra-files
  pulumi.log.info(`${config.name}: preparing extra-files`);
  const extraDir = prepareExtraFiles({
    hostEd25519,
    hostRsa,
    initrdKey,
    clevisJWE,
  });

  // Write LUKS passphrase to temp file for nixos-anywhere
  const passFile = join(extraDir, ".luks-pass");
  writeFileSync(passFile, luksPassphrase, { mode: 0o600 });

  // 9. Wait for iPXE instance SSH
  pulumi.log.info(`${config.name}: waiting for iPXE instance SSH at ${ip}`);
  waitForSSH(ip, { timeout: 600 });

  // 10. Run nixos-anywhere
  pulumi.log.info(`${config.name}: running nixos-anywhere`);
  execSync(
    [
      "nixos-anywhere",
      "--flake",
      config.flakeRef,
      "--disk-encryption-keys",
      "/tmp/disk-password",
      passFile,
      "--extra-files",
      extraDir,
      "--phases",
      '"disko install"',
      `root@${ip}`,
    ].join(" "),
    {
      stdio: "inherit",
      timeout: 1800_000, // 30 minutes
      env: {
        ...process.env,
        NIX_CONFIG: "experimental-features = nix-command flakes",
      },
    }
  );

  // 11. Wait for reboot + verify
  pulumi.log.info(`${config.name}: waiting for reboot`);
  waitForSSHDown(ip, { timeout: 120 });
  pulumi.log.info(`${config.name}: waiting for post-install SSH`);
  waitForSSH(ip, { timeout: 600 });

  pulumi.log.info(`${config.name}: verifying health`);
  verifyNodeHealth(ip, config.name);

  // Cleanup
  rmSync(extraDir, { recursive: true });

  pulumi.log.info(`${config.name}: provisioning complete`);

  return { luksPassphrase, agePublicKey };
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
