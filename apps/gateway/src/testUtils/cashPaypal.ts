import { expect } from "bun:test";
import { fileURLToPath } from "node:url";
import type { PaypalFetch } from "@aiverse/hunt/paypal";

export function mockCashPaypal(contestId: string, mode: "sandbox" | "live", recipientEmail: string) {
  let batches = 0;
  let submittedItem: { receiver: string; sender_item_id: string; amount: { value: string; currency: string } } | undefined;
  const transport: PaypalFetch = async (url, request) => {
    const path = new URL(url);
    expect(path.origin).toBe(mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
    if (path.pathname === "/v1/oauth2/token") {
      return { status: 200, json: { access_token: "test-only", expires_in: 3600, token_type: "Bearer" } };
    }
    if (request.method === "POST" && path.pathname === "/v1/payments/payouts") {
      batches++;
      const batch = JSON.parse(request.body!);
      expect(batch).toMatchObject({
        sender_batch_header: { sender_batch_id: `hunt-${mode === "live" ? "live" : "sbx"}-embodied-cash-${contestId}` },
        items: [{ receiver: recipientEmail, amount: { value: "1.00", currency: "USD" } }],
      });
      submittedItem = batch.items[0];
      return { status: 201, json: { batch_header: { payout_batch_id: "TEST-BATCH", batch_status: "SUCCESS" } } };
    }
    if (request.method === "GET" && path.pathname === "/v1/payments/payouts/TEST-BATCH") {
      if (!submittedItem) return { status: 404, json: { name: "RESOURCE_NOT_FOUND" } };
      return { status: 200, json: {
        batch_header: { payout_batch_id: "TEST-BATCH" },
        items: [{ payout_item_id: "TEST-ITEM", transaction_status: "SUCCESS",
          transaction_id: "TEST-TRANSACTION", payout_item: submittedItem }],
      } };
    }
    throw new Error(`Unexpected test PayPal call ${request.method} ${path.pathname}`);
  };
  return { transport, get batches() { return batches; } };
}

interface SdkPayoutProbe {
  batchId: string;
  itemId: string;
  senderItemId: string;
  transactionId: string;
  recipient: string;
  amountCents: number;
}

export async function runPaypalSdkProbe(probe?: SdkPayoutProbe, mock?: PaypalFetch) {
  const script = fileURLToPath(new URL("../../../hunt/scripts/e2e/verify_paypal_sdk.py", import.meta.url));
  const server = mock && Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname, search } = new URL(request.url);
      const result = await mock("https://api-m.sandbox.paypal.com" + pathname + search, {
        method: request.method, headers: Object.fromEntries(request.headers),
        body: request.body ? await request.text() : undefined,
      });
      return Response.json(result.json, { status: result.status });
    },
  });
  try {
    const child = Bun.spawn(
      ["uv", "run", "--no-project", script, ...(probe ? [] : ["--check"])],
      {
        stdin: probe ? new Blob([JSON.stringify({ ...probe, mockPort: server ? server.port : undefined })]) : "ignore",
        stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(30_000),
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(stderr.trim() || "PayPal SDK probe failed");
    if (probe) expect(stdout.trim()).toBe("PayPal SDK verified one settled payout item");
  } finally {
    if (server) server.stop(true);
  }
}
