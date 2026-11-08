#!/usr/bin/env node
// Prints the base64 of an argon2id hash of a password, for BOOTSTRAP_COORD_HASH_B64 (see README → Təşkilatlar).
// The password is read from stdin only — never from argv or the environment — and is never printed or logged.
//   printf '%s' 'parol' | node scripts/hash-password.mjs        (non-interactive; no trailing newline is hashed)
//   node scripts/hash-password.mjs                              (interactive: asks twice, input hidden)
// Same argon2 parameters as server/baseline.ts (ARGON); test/orgs.test.ts checks that they match.
import { hash } from "@node-rs/argon2";

const ARGON = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const MIN = 8;

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = ch => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); stderr.write("\n"); resolve(buf); return; }
        if (c === "\u0003") { stdin.setRawMode(false); stderr.write("\n"); reject(new Error("cancelled")); return; }
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1); else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPassword() {
  if (process.stdin.isTTY) {
    const a = await readHidden("Şifrə: ");
    const b = await readHidden("Təkrar: ");
    if (a !== b) throw new Error("Şifrələr eyni deyil.");
    return a;
  }
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  // one trailing newline (echo / heredoc) is not part of the password
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

try {
  const pw = await readPassword();
  if (pw.length < MIN) throw new Error(`Şifrə ən azı ${MIN} simvol olmalıdır.`);
  const h = await hash(pw, ARGON);
  process.stdout.write(Buffer.from(h, "utf8").toString("base64") + "\n");
} catch (e) {
  process.stderr.write(`hash-password: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
