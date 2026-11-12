/**
 * Hunt mailer (SPEC §4, §11.5 built to the recommendation).
 * Default mode is `log`: mail is appended to a dev outbox file and the
 * server log — the local/stub path used by tests and the slice-7 E2E. This
 * build makes NO DNS or production email-config changes. `resend` mode
 * sends through the workspace's existing Resend connection.
 *
 * Two kinds of mail exist: magic sign-in links, and — since the
 * claim-email build (Jim's call, 2026-11-10) — the prize code emailed to
 * a winner at win time. Codes also stay readable in-band (claim response
 * + GET /v1/me/wins); the email is the copy that reaches the inbox.
 */
import { appendFileSync } from "node:fs";

/** What a winner is emailed: the decrypted code plus the prize's public
 *  label and kind (never coordinates — invariant I4 is about responses,
 *  but the mail body holds to the same line). */
export interface ClaimCodePrize {
  code: string;
  label: string;
  kind: string;
}

export interface Mailer {
  sendMagicLink(email: string, link: string): Promise<void>;
  sendClaimCode(email: string, prize: ClaimCodePrize): Promise<void>;
}

export class LogMailer implements Mailer {
  /** In-memory capture for tests. */
  sent: { email: string; link: string }[] = [];
  sentClaimCodes: { email: string; code: string; label: string; kind: string }[] = [];
  constructor(private outboxPath: string | null = null) {}
  async sendMagicLink(email: string, link: string): Promise<void> {
    this.sent.push({ email, link });
    console.log(`[hunt:mail:stub] magic link for ${email}: ${link}`);
    if (this.outboxPath) {
      appendFileSync(this.outboxPath, JSON.stringify({ email, link, at: Date.now() }) + "\n");
    }
  }
  async sendClaimCode(email: string, prize: ClaimCodePrize): Promise<void> {
    this.sentClaimCodes.push({ email, code: prize.code, label: prize.label, kind: prize.kind });
    console.log(`[hunt:mail:stub] prize code for ${email} (${prize.label}): ${prize.code}`);
    if (this.outboxPath) {
      appendFileSync(
        this.outboxPath,
        JSON.stringify({ email, code: prize.code, label: prize.label, kind: prize.kind, at: Date.now() }) + "\n",
      );
    }
  }
}

export class ResendMailer implements Mailer {
  constructor(
    private apiKey: string,
    private from: string,
  ) {}
  private async send(email: string, subject: string, text: string): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: this.from, to: [email], subject, text }),
    });
    if (!res.ok) {
      throw new Error(`resend send failed: ${res.status} ${await res.text()}`);
    }
  }
  async sendMagicLink(email: string, link: string): Promise<void> {
    await this.send(
      email,
      "Your AIVerse hunt sign-in link",
      `Open this link within 15 minutes to sign in to the hunt:\n\n${link}\n\nIf you didn't request it, ignore this email.`,
    );
  }
  async sendClaimCode(email: string, prize: ClaimCodePrize): Promise<void> {
    await this.send(
      email,
      "Your AIVerse hunt prize code",
      `You won a prize in the AIVerse hunt: ${prize.label}\n\nYour prize code: ${prize.code}\nPrize type: ${prize.kind}\n\nKeep this email — the code is your prize. You can also see it any time under your wins in the hunt.`,
    );
  }
}
