/**
 * Magic-link mailer (SPEC §4, §11.5 built to the recommendation).
 * Default mode is `log`: the link is appended to a dev outbox file and the
 * server log — the local/stub path used by tests and the slice-7 E2E. This
 * build makes NO DNS or production email-config changes. `resend` mode
 * sends through the workspace's existing Resend connection.
 */
import { appendFileSync } from "node:fs";

export interface Mailer {
  sendMagicLink(email: string, link: string): Promise<void>;
}

export class LogMailer implements Mailer {
  /** In-memory capture for tests. */
  sent: { email: string; link: string }[] = [];
  constructor(private outboxPath: string | null = null) {}
  async sendMagicLink(email: string, link: string): Promise<void> {
    this.sent.push({ email, link });
    console.log(`[hunt:mail:stub] magic link for ${email}: ${link}`);
    if (this.outboxPath) {
      appendFileSync(this.outboxPath, JSON.stringify({ email, link, at: Date.now() }) + "\n");
    }
  }
}

export class ResendMailer implements Mailer {
  constructor(
    private apiKey: string,
    private from: string,
  ) {}
  async sendMagicLink(email: string, link: string): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [email],
        subject: "Your AIVerse hunt sign-in link",
        text: `Open this link within 15 minutes to sign in to the hunt:\n\n${link}\n\nIf you didn't request it, ignore this email.`,
      }),
    });
    if (!res.ok) {
      throw new Error(`resend send failed: ${res.status} ${await res.text()}`);
    }
  }
}
