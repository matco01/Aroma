/**
 * Invite codes: a short thing to type instead of a link to click.
 *
 * An invite is a 101-byte signature (see club-trade.ts), far too long to type,
 * so a code is not the invite itself: it is a key the server looks the signed
 * invite up by. See server/invite-codes.ts for the store and why it can only
 * lose an invite, never forge one.
 *
 * Eight characters of Crockford base32, shown as `K7Q2-XMPD`. The alphabet has
 * no I, L, O or U, so a code read out loud or copied off a screenshot survives
 * the usual confusions, and typing an O or an I is forgiven rather than
 * refused. 32^8 is about 10^12 codes, against which guessing a live one — with
 * lookups rate limited — is not a way to get a seat.
 */

export const INVITE_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const INVITE_CODE_LENGTH = 8;

/** The canonical form — eight characters, no dash — or null if it can't be one. */
export function normalizeInviteCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length !== INVITE_CODE_LENGTH) return null;
  for (const c of s) if (!INVITE_CODE_ALPHABET.includes(c)) return null;
  return s;
}

/** `K7Q2XMPD` -> `K7Q2-XMPD`. */
export function formatInviteCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
