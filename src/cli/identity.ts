// seed-identity — derive IPNS CID from an Ed25519 SSH public key
//
// Usage:
//   seed-identity <pubkey-file>        # read from file
//   seed-identity                      # read from stdin
//
// Reads an ssh-ed25519 public key and outputs the IPNS CID for .seed-identity.
// Also accepts a private key file — extracts the public key automatically.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ipnsCidFromSshPubkey } from "../shared/identity.js";

function usage(): never {
  process.stderr.write(
    "usage: seed-identity [<pubkey-or-privkey-file>]\n" +
    "\n" +
    "Derive the IPNS CID from an Ed25519 SSH key.\n" +
    "Reads from stdin if no file argument is given.\n" +
    "\n" +
    "Accepts either a public key (.pub) or a private key file.\n" +
    "If given a private key, extracts the public key via ssh-keygen.\n"
  );
  process.exit(1);
}

function readPubkey(file?: string): string {
  let content: string;
  if (file) {
    content = readFileSync(file, "utf-8").trim();
  } else {
    content = readFileSync(0, "utf-8").trim();
  }

  // If it's already a public key, return it
  if (content.startsWith("ssh-ed25519 ")) {
    return content;
  }

  // If it looks like a private key, extract the public key
  if (content.includes("PRIVATE KEY")) {
    if (!file) {
      process.stderr.write("error: private key on stdin not supported — pass as file argument\n");
      process.exit(1);
    }
    try {
      return execFileSync("ssh-keygen", ["-y", "-f", file], { encoding: "utf-8" }).trim();
    } catch {
      process.stderr.write("error: failed to extract public key (is ssh-keygen in PATH?)\n");
      process.exit(1);
    }
  }

  process.stderr.write("error: not an ssh-ed25519 key\n");
  process.exit(1);
}

const file = process.argv[2];
if (file === "--help" || file === "-h") usage();

const pubkey = readPubkey(file);
const cid = ipnsCidFromSshPubkey(pubkey);
process.stdout.write(cid + "\n");
