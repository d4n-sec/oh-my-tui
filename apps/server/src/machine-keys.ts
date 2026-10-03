import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { utils } from "ssh2";
import type { SshHostKey } from "@oh-my-tui/protocol";

/** Marker comment used to identify application-owned authorized_keys entries. */
export const AUTH_KEY_MARKER = "oh-my-tui";

export function hostKeyFingerprint(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

export function fingerprintFromHostKey(hostKey: SshHostKey): string {
  return hostKeyFingerprint(Buffer.from(hostKey.key, "base64"));
}

export function machineKeysDir(dataDir: string): string {
  return path.join(dataDir, "machine-keys");
}

function privateKeyPath(dataDir: string, machineId: string): string {
  return path.join(machineKeysDir(dataDir), `${machineId}.key`);
}

/**
 * Create an ed25519 login keypair for a machine. The private key is written with
 * 0600 permissions and never leaves the Server; only the public key is returned.
 */
export function ensureMachineKeypair(
  dataDir: string,
  machineId: string,
): { privateKeyPem: string; publicKeyLine: string } {
  const dir = machineKeysDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = privateKeyPath(dataDir, machineId);
  if (fs.existsSync(file)) {
    const privateKeyPem = fs.readFileSync(file, "utf8");
    const publicKeyLine = publicLineFromPrivate(privateKeyPem, machineId);
    return { privateKeyPem, publicKeyLine };
  }
  const { private: privateKeyPem, public: publicKey } = utils.generateKeyPairSync("ed25519");
  fs.writeFileSync(file, privateKeyPem, { mode: 0o600 });
  const parsed = utils.parseKey(publicKey);
  if (parsed instanceof Error) throw parsed;
  const blob = parsed.getPublicSSH();
  const publicKeyLine = `ssh-ed25519 ${blob.toString("base64")} ${AUTH_KEY_MARKER}:${machineId}`;
  return { privateKeyPem, publicKeyLine };
}

function publicLineFromPrivate(privateKeyPem: string, machineId: string): string {
  const parsed = utils.parseKey(privateKeyPem);
  if (parsed instanceof Error) throw parsed;
  const blob = parsed.getPublicSSH();
  return `ssh-ed25519 ${blob.toString("base64")} ${AUTH_KEY_MARKER}:${machineId}`;
}

export function readMachinePublicKeyLine(dataDir: string, machineId: string): string {
  const file = privateKeyPath(dataDir, machineId);
  const privateKeyPem = fs.readFileSync(file, "utf8");
  return publicLineFromPrivate(privateKeyPem, machineId);
}

export function readMachinePrivateKey(dataDir: string, machineId: string): string {
  return fs.readFileSync(privateKeyPath(dataDir, machineId), "utf8");
}

export function machineKeyExists(dataDir: string, machineId: string): boolean {
  return fs.existsSync(privateKeyPath(dataDir, machineId));
}

export function deleteMachineKey(dataDir: string, machineId: string): void {
  fs.rmSync(privateKeyPath(dataDir, machineId), { force: true });
}

export function matchesPinnedHostKey(blob: Buffer, pinned: SshHostKey[]): boolean {
  const fp = hostKeyFingerprint(blob);
  return pinned.some((k) => fingerprintFromHostKey(k) === fp);
}
