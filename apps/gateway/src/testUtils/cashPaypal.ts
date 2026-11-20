import { expect } from "bun:test";
import type { PaypalFetch } from "@aiverse/hunt/paypal";

export function mockCashPaypal(contestId: string, mode: "sandbox" | "live", recipientEmail: string) {
  let batches = 0;
  const transport: PaypalFetch = async (url, request) => {
    const path = new URL(url);
    expect(path.origin).toBe(mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
    if (path.pathname === "/v1/oauth2/token") {
      return { status: 200, json: { access_token: "test-only", expires_in: 3600 } };
    }
    if (request.method === "POST" && path.pathname === "/v1/payments/payouts") {
      batches++;
      expect(JSON.parse(request.body!)).toMatchObject({
        sender_batch_header: { sender_batch_id: `hunt-${mode === "live" ? "live" : "sbx"}-embodied-cash-${contestId}` },
        items: [{ receiver: recipientEmail, amount: { value: "1.00", currency: "USD" } }],
      });
      return { status: 201, json: { batch_header: { payout_batch_id: "TEST-BATCH", batch_status: "SUCCESS" } } };
    }
    if (request.method === "GET" && path.pathname === "/v1/payments/payouts/TEST-BATCH") {
      return { status: 200, json: { items: [
        { payout_item_id: "TEST-ITEM", transaction_status: "SUCCESS", transaction_id: "TEST-TRANSACTION" },
      ] } };
    }
    throw new Error(`Unexpected test PayPal call ${request.method} ${path.pathname}`);
  };
  return { transport, get batches() { return batches; } };
}
