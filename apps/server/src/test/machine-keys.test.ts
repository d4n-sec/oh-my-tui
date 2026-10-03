import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureMachineKeypair,
  deleteMachineKey,
  fingerprintFromHostKey,
  hostKeyFingerprint,
  readMachinePrivateKey,
  readMachinePublicKeyLine,
  matchesPinnedHostKey,
} from "../machine-keys";

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "otm-keys-"));
}

test("machine keypair is created with 0600 private key and a parsable public line", () => {
  const dir = tempDataDir();
  const { privateKeyPem, publicKeyLine } = ensureMachineKeypair(dir, "m_abc");
  assert.match(publicKeyLine, /^ssh-ed25519 [A-Za-z0-9+/=]+ oh-my-tui:m_abc$/);
  const keyFile = path.join(dir, "machine-keys", "m_abc.key");
  const mode = fs.statSync(keyFile).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(readMachinePrivateKey(dir, "m_abc"), privateKeyPem);
  assert.equal(readMachinePublicKeyLine(dir, "m_abc"), publicKeyLine);
});

test("machine keypair generation is idempotent", () => {
  const dir = tempDataDir();
  const first = ensureMachineKeypair(dir, "m_abc");
  const second = ensureMachineKeypair(dir, "m_abc");
  assert.equal(first.publicKeyLine, second.publicKeyLine);
  assert.equal(first.privateKeyPem, second.privateKeyPem);
});

test("public key line fingerprint matches the pinned host key form", () => {
  const dir = tempDataDir();
  const { publicKeyLine } = ensureMachineKeypair(dir, "m_abc");
  const b64 = publicKeyLine.split(" ")[1] ?? "";
  const blob = Buffer.from(b64, "base64");
  const pinned = [{ type: "ssh-ed25519", key: b64 }];
  assert.equal(matchesPinnedHostKey(blob, pinned), true);
  assert.equal(fingerprintFromHostKey(pinned[0]!), hostKeyFingerprint(blob));
  assert.equal(matchesPinnedHostKey(Buffer.from("other"), pinned), false);
});

test("deleteMachineKey removes the private key", () => {
  const dir = tempDataDir();
  ensureMachineKeypair(dir, "m_abc");
  deleteMachineKey(dir, "m_abc");
  assert.equal(fs.existsSync(path.join(dir, "machine-keys", "m_abc.key")), false);
});
