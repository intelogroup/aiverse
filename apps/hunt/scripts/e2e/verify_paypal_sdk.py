# /// script
# requires-python = ">=3.9"
# dependencies = ["paypal-payouts-sdk==1.0.0", "paypalhttp==1.0.1"]
# ///
"""Check the PayPal payout item independently of the gateway's settlement read."""

import json
import os
import sys
from decimal import Decimal

from paypalpayoutssdk.core import PayPalHttpClient, SandboxEnvironment
from paypalpayoutssdk.payouts import PayoutsGetRequest


def main():
    if sys.argv[1:] == ["--check"]:
        return
    expected = json.load(sys.stdin)
    mock_port = expected.get("mockPort")
    if mock_port is not None:
        if type(mock_port) is not int or not 0 < mock_port <= 65535:
            raise ValueError("Invalid mock port")
        environment = SandboxEnvironment("sdk-mock-client", "sdk-mock-secret")
        environment.base_url = f"http://127.0.0.1:{mock_port}"
    else:
        environment = SandboxEnvironment(
            os.environ["AIVERSE_PAYPAL_SANDBOX_CLIENT_ID"],
            os.environ["AIVERSE_PAYPAL_SANDBOX_CLIENT_SECRET"],
        )

    batch = PayPalHttpClient(environment).execute(PayoutsGetRequest(expected["batchId"])).result
    if batch.batch_header.payout_batch_id != expected["batchId"] or len(batch.items) != 1:
        raise ValueError("Expected one item in the recorded payout batch")
    item = batch.items[0]
    payout = item.payout_item
    if item.transaction_status != "SUCCESS" or item.transaction_id != expected["transactionId"]:
        raise ValueError("Settlement does not match the owner receipt")
    if (item.payout_item_id != expected["itemId"]
            or payout.sender_item_id != expected["senderItemId"]
            or payout.receiver.casefold() != expected["recipient"].casefold()
            or payout.amount.currency != "USD"
            or Decimal(payout.amount.value) != Decimal(expected["amountCents"]) / 100):
        raise ValueError("Payout identity, amount, or recipient does not match the bounty")
    print("PayPal SDK verified one settled payout item")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError) as error:
        # Keep provider response bodies and credentials out of test output.
        if isinstance(error, KeyError):
            raise SystemExit("Missing PayPal SDK test input") from None
        raise SystemExit(str(error)) from None
    except Exception as error:
        status = getattr(error, "status_code", None)
        raise SystemExit(f"PayPal SDK request failed ({type(error).__name__}, HTTP {status})") from None
