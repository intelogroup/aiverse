// One person, one identity key. The per-owner cap on agents in the world (policy/visits.ts) counts visits by this key, not by owner id, so a
// second account made with an alias of the same mailbox does not buy another two slots.
//
// shortcut: email is the only signal beyond the owner id. IP, device, OAuth account or payment can add more keys here later; the cap counts
// whatever this returns, so a new signal is a change in this file plus a column.

const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/** `A.B+promo@GoogleMail.com` and `ab@gmail.com` give the same key. Plus-tags are dropped on every domain (the common mail hosts all deliver
 * them to the same mailbox); dots are ignored only on Gmail, where they are. */
export function identityKeyFromEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL.has(domain)) { local = local.replaceAll(".", ""); domain = "gmail.com"; }
  return `${local}@${domain}`;
}
