export type DonationPayload = {
  amount: number;
  currency: string;
  note?: string;
  locale: "ko" | "en";
  region: "domestic" | "international";
};

export type CheckoutSession = {
  orderId: string;
  attemptId: string;
  redirectUrl: string;
  provider: "paypal";
};

export async function createPayPalCheckout(apiBaseUrl: string, payload: DonationPayload): Promise<CheckoutSession> {
  const idempotencyKey = crypto.randomUUID();
  const orderResponse = await fetch(`${apiBaseUrl}/api/v1/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify(payload)
  });

  if (!orderResponse.ok) {
    throw new Error("Failed to create order.");
  }

  const orderJson = await orderResponse.json() as { order: { id: string } };
  const checkoutResponse = await fetch(`${apiBaseUrl}/api/v1/orders/${orderJson.order.id}/payment-attempts/paypal`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    }
  });

  if (!checkoutResponse.ok) {
    throw new Error("Failed to create PayPal checkout.");
  }

  const checkoutJson = await checkoutResponse.json() as { attempt: { id: string }; redirectUrl: string };
  return {
    orderId: orderJson.order.id,
    attemptId: checkoutJson.attempt.id,
    redirectUrl: checkoutJson.redirectUrl,
    provider: "paypal"
  };
}
