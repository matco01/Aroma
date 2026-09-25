import "server-only";
import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH } from "../invite-code";

/**
 * Invite codes -> the signed invites they stand for.
 *
 * What the server holds here is not trusted, and does not need to be. The
 * invite is the inviter's EIP-712 signature and the vault checks it on every
 * redemption, so the worst a lost, corrupted or tampered store can do is make
 * a code stop working. It cannot let anyone in who wasn't invited. That is why
 * this is a file and not a database: it needs to survive a redeploy, not to be
 * a system of record.
 *
 * An append-only JSON-lines file, read once into memory. Same single-process
 * assumption as the rest of src/lib/server (DEPLOY.md, "Why one process"): two
 * replicas would each keep their own view of the file. Expired invites are
 * dropped on load, and the file is rewritten without them, so it only ever
 * holds invites that could still be used.
 *
 * In production it must be on a persistent volume — INVITE_STORE_PATH. Without
 * one the store is off rather than quietly living in the container's disk,
 * where every deploy would wipe every code anyone had handed out. Off, the
 * site falls back to invite links, which carry the whole invite and need no
 * storage.
 */

type Entry = {
  code: string;
  /** The coin, lowercased. */
  token: string;
  /** The invite as encodeInvite writes it. */
  invite: string;
  /** Unix seconds. After this the invite is dead on-chain anyway. */
  deadline: number;
};

// The turbopackIgnore comments on this path and every fs call below: without
// them the build can't tell which file a run-time path means, so it traces the
// whole project into the standalone server to be safe. The store is only ever
// created at run time; there is nothing here to bundle.
const STORE_PATH =
  process.env.INVITE_STORE_PATH ||
  (process.env.NODE_ENV === "production"
    ? ""
    : path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "invite-codes.jsonl"));

export const hasInviteStore = Boolean(STORE_PATH);

let byCode: Map<string, Entry> | null = null;
let byInvite: Map<string, string> | null = null;

function now() {
  return Math.floor(Date.now() / 1000);
}

function load() {
  if (byCode && byInvite) return { byCode, byInvite };
  byCode = new Map();
  byInvite = new Map();

  let text = "";
  try {
    text = fs.readFileSync(/* turbopackIgnore: true */ STORE_PATH, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const t = now();
  let dropped = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as Entry;
      if (e.deadline < t) {
        dropped++;
        continue;
      }
      byCode.set(e.code, e);
      byInvite.set(e.invite, e.code);
    } catch {
      // A torn last line from a crash mid-append. Everything before it is intact.
      dropped++;
    }
  }

  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(STORE_PATH), { recursive: true });
  if (dropped > 0) {
    // Compact: write the live entries to a new file and swap it in, so a crash
    // here leaves either the old file or the new one, never half of one.
    const tmp = `${STORE_PATH}.tmp`;
    fs.writeFileSync(/* turbopackIgnore: true */ tmp, [...byCode.values()].map((e) => JSON.stringify(e) + "\n").join(""));
    fs.renameSync(/* turbopackIgnore: true */ tmp, STORE_PATH);
  }
  return { byCode, byInvite };
}

function newCode(taken: Map<string, Entry>): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
      code += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
    }
    if (!taken.has(code)) return code;
  }
}

/**
 * The code for an invite, making one if it has none. The same invite always
 * gets the same code, so asking twice doesn't mint a second one.
 */
export function codeForInvite(token: string, invite: string, deadline: number): string {
  const store = load();
  const existing = store.byInvite.get(invite);
  if (existing) return existing;

  const entry: Entry = { code: newCode(store.byCode), token: token.toLowerCase(), invite, deadline };
  fs.appendFileSync(/* turbopackIgnore: true */ STORE_PATH, JSON.stringify(entry) + "\n");
  store.byCode.set(entry.code, entry);
  store.byInvite.set(invite, entry.code);
  return entry.code;
}

/** The invite a code stands for, or null if there is none or it has expired. */
export function inviteForCode(code: string): { token: string; invite: string } | null {
  const entry = load().byCode.get(code);
  if (!entry || entry.deadline < now()) return null;
  return { token: entry.token, invite: entry.invite };
}
