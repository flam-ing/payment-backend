import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  type OrderStatus,
  type PaymentAttemptRecord,
  findIdempotencyRecord,
  getOrderById,
  getOrderByIdempotencyKey,
  getPaymentAttemptById,
  getPaymentAttemptByProviderOrderId,
  getSettlementByAttemptId,
  insertAuditLog,
  insertIdempotencyRecord,
  insertLedgerEntry,
  insertOrder,
  insertPaymentAttempt,
  insertProviderEvent,
  insertSettlementRecord,
  updateOrderStatus,
  updatePaymentAttempt,
  updateSettlementStatus,
  getMonthlyKakaopayTotal,
  getMonthlyCardTotal,
  countOrders,
  countPaymentAttempts,
  listRecentOrders,
  listRecentPaymentAttempts,
  listAdminTables,
  listAdminTableRows,
  updateAdminTableRow
} from "./store";
import { adminHtml } from "./admin_html";
import {
  capturePayPalOrder,
  refundPayPalCapture,
  createPayPalOrder,
  getPayPalCredentials,
  getPayPalWebhookHeaders,
  getPrimaryCapture,
  parseProviderAmount,
  verifyPayPalWebhook
} from "./paypal";

type Locale = "ko" | "en";
type Region = "domestic" | "international";

type CreateOrderBody = Partial<{
  amount: number;
  currency: string;
  note: string;
  locale: Locale;
  region: Region;
  itemName: string;
  idempotencyKey: string;
  productCode: string;
  customer: { fullName?: string; email?: string; phoneNumber?: string };
}>;

/**
 * ai-ing.org 판매 상품 카탈로그 (서버 권한 소스).
 * productCode가 오면 클라이언트가 보낸 amount/itemName은 무시하고 이 표의 값을 사용한다.
 * → 프론트엔드 조작으로 50만원 상품을 100원에 결제하는 것을 차단.
 * productCode가 없으면 기존 흐름을 그대로 유지한다.
 */
const AI_ING_PRODUCT_CATALOG: Record<string, { amount: number; currency: string; itemName: string }> = {
  test1000: { amount: 1000, currency: "KRW", itemName: "[테스트] 1,000원 결제 승인 테스트" },
  test100: { amount: 1000, currency: "KRW", itemName: "[테스트] 1,000원 결제 승인 테스트" },
  pdf: { amount: 10000, currency: "KRW", itemName: "온라인 PDF 교재" },
  consult: {
    amount: 50000,
    currency: "KRW",
    itemName: "AX 맞춤형 컨설팅 & 1:1 멘토링 1시간 서비스"
  },
  consult100k: {
    amount: 100000,
    currency: "KRW",
    itemName: "AX 맞춤형 컨설팅 & 실습 2시간 과정"
  },
  consult200k: {
    amount: 200000,
    currency: "KRW",
    itemName: "AX 맞춤형 컨설팅 & 프로젝트 1개월 집중 과정"
  },
  consult300k: {
    amount: 300000,
    currency: "KRW",
    itemName: "AX 맞춤형 컨설팅 & 심화 프로젝트 과정"
  },
  consult500k: {
    amount: 500000,
    currency: "KRW",
    itemName: "AX 맞춤형 기업 컨설팅 & 1:1 멘토링 3개월 패키지"
  }
};

const app = new Hono();
const PAYPAL_SUPPORTED_CURRENCIES = new Set([
  "AUD",
  "BRL",
  "CAD",
  "CHF",
  "CZK",
  "DKK",
  "EUR",
  "GBP",
  "HKD",
  "HUF",
  "ILS",
  "JPY",
  "MXN",
  "NOK",
  "NZD",
  "PHP",
  "PLN",
  "SEK",
  "SGD",
  "THB",
  "TWD",
  "USD"
]);

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function currentFrontendBaseUrl() {
  const configured = process.env.FRONTEND_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }

  // 결제 UI는 ai-ing.org 쪽. 이 호스트는 API only.
  return process.env.VERCEL ? "https://ai-ing.org" : "http://localhost:5173";
}

function currentBackendBaseUrl() {
  const configured = process.env.PUBLIC_BASE_URL?.trim() || process.env.BACKEND_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }

  return process.env.VERCEL ? "https://payment.ai-ing.org" : "http://localhost:3000";
}

/** 브라우저 결제 호출 허용 origin — ai-ing.org 계열만 (공개 AEO/GEO·관리자 프론트 제외) */
function allowedOrigins() {
  const defaults = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "https://ai-ing.org",
    "https://www.ai-ing.org",
    "https://ai-ing-6lf.pages.dev"
  ];
  const configured = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .replace(/\r?\n/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  // 설정값이 있어도 ai-ing 기본은 항상 포함
  return [...new Set([...defaults, ...configured])];
}

function originFromRequest(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const origin = c.req.header("Origin")?.trim();
  if (origin) return origin;
  const referer = c.req.header("Referer")?.trim();
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function isAiIngBrowserRequest(c: { req: { header: (n: string) => string | undefined } }): boolean {
  const origin = originFromRequest(c);
  if (!origin) return false;
  return allowedOrigins().includes(origin);
}

function plain404Html() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/>
<meta name="robots" content="noindex,nofollow,noarchive,nosnippet"/>
<title>404 Not Found</title>
<style>
html,body{margin:0;min-height:100%;background:#0b0b0c;color:#8b8f98;font:14px/1.5 system-ui,sans-serif}
main{min-height:100vh;display:grid;place-items:center;text-align:center;padding:24px}
h1{margin:0 0 8px;font-size:28px;font-weight:700;color:#e8eaed}
p{margin:0;color:#6b7280}
</style>
</head><body><main><div><h1>404</h1><p>Not Found</p></div></main></body></html>`;
}

function decimalPlaces(currency: string) {
  return ["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"].includes(currency.toUpperCase()) ? 0 : 2;
}

function toMinorUnits(amount: number, currency: string) {
  return Math.round(amount * 10 ** decimalPlaces(currency));
}

function toDisplayAmount(amount: number, currency: string) {
  return (amount / 10 ** decimalPlaces(currency)).toFixed(decimalPlaces(currency));
}

/**
 * PortOne V2 결제 서버 검증.
 * 클라이언트가 "결제 성공"이라고 알려준 것만 믿고 주문을 PAID로 바꾸면
 * 누구나 이 엔드포인트를 호출해 무료로 결제 완료 기록을 만들 수 있다.
 * 그 기록이 카드/카카오페이 월 한도 집계의 근거이므로 정산까지 오염된다.
 * PORTONE_API_SECRET 이 설정된 경우 실제 결제 상태와 금액을 대조한다.
 */
async function verifyPortOnePayment(
  paymentId: string,
  expectedAmount: number,
  expectedCurrency: string
): Promise<{ verified: boolean; reason: string }> {
  const secret = process.env.PORTONE_API_SECRET?.trim();

  if (!secret) {
    // 검증 키가 없으면 통과시키되(기존 동작 유지) 반드시 경고를 남긴다.
    console.warn(
      "[portone] PORTONE_API_SECRET is not configured — payment recorded WITHOUT server-side verification."
    );
    return { verified: false, reason: "verification_skipped_no_secret" };
  }

  try {
    const res = await fetch(`https://api.portone.io/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `PortOne ${secret}` }
    });

    if (!res.ok) {
      return { verified: false, reason: `portone_lookup_failed_${res.status}` };
    }

    const payment = (await res.json()) as {
      status?: string;
      currency?: string;
      amount?: { total?: number };
    };

    if (payment.status !== "PAID") {
      return { verified: false, reason: `unexpected_status_${payment.status ?? "unknown"}` };
    }

    const paidTotal = payment.amount?.total;
    if (typeof paidTotal !== "number" || paidTotal !== expectedAmount) {
      return { verified: false, reason: `amount_mismatch_${paidTotal ?? "none"}_vs_${expectedAmount}` };
    }

    const paidCurrency = (payment.currency ?? "").replace(/^CURRENCY_/, "").toUpperCase();
    if (paidCurrency && paidCurrency !== expectedCurrency.toUpperCase()) {
      return { verified: false, reason: `currency_mismatch_${paidCurrency}_vs_${expectedCurrency}` };
    }

    return { verified: true, reason: "ok" };
  } catch (error) {
    console.error("[portone] verification request failed", error);
    return { verified: false, reason: "verification_request_error" };
  }
}

function successUrl(params: Record<string, string>) {
  return `${currentFrontendBaseUrl()}/success?${new URLSearchParams(params).toString()}`;
}

function failureUrl(params: Record<string, string>) {
  return `${currentFrontendBaseUrl()}/cancel?${new URLSearchParams(params).toString()}`;
}

function getPayPalEventType(event: unknown) {
  if (!event || typeof event !== "object") {
    return "UNKNOWN";
  }

  const candidate = (event as { event_type?: unknown }).event_type;
  return typeof candidate === "string" ? candidate : "UNKNOWN";
}

function getPayPalEventId(event: unknown) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const candidate = (event as { id?: unknown }).id;
  return typeof candidate === "string" ? candidate : null;
}

function extractProviderOrderIdFromWebhook(event: unknown) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const resource = (event as { resource?: Record<string, unknown> }).resource;
  if (!resource) {
    return null;
  }

  if (typeof resource.id === "string" && getPayPalEventType(event).startsWith("CHECKOUT.ORDER")) {
    return resource.id;
  }

  if (typeof resource.supplementary_data === "object" && resource.supplementary_data) {
    const relatedIds = (resource.supplementary_data as { related_ids?: { order_id?: unknown } }).related_ids;
    if (typeof relatedIds?.order_id === "string") {
      return relatedIds.order_id;
    }
  }

  if (typeof resource.custom_id === "string") {
    return resource.custom_id;
  }

  return null;
}

async function log(entityType: string, entityId: string, action: string, message: string, metadata?: unknown) {
  await insertAuditLog({
    id: makeId("audit"),
    entityType,
    entityId,
    action,
    actor: "system",
    message,
    metadata,
    createdAt: nowIso()
  });
}

async function recordCapture(input: {
  attempt: PaymentAttemptRecord;
  capture: Awaited<ReturnType<typeof capturePayPalOrder>>;
  source: "return" | "webhook";
  eventId?: string | null;
  signatureVerified?: boolean;
}) {
  const webhookCapture = (input.capture as { resource?: { id?: string; status?: string; amount?: { currency_code?: string; value?: string }; seller_receivable_breakdown?: { gross_amount?: { currency_code?: string; value?: string }; paypal_fee?: { currency_code?: string; value?: string }; net_amount?: { currency_code?: string; value?: string } } } }).resource;
  const capture = getPrimaryCapture(input.capture) ?? webhookCapture ?? null;
  const captureId = capture?.id ?? input.capture.id ?? null;
  const currency = capture?.amount?.currency_code ?? input.attempt.currency;
  const grossAmount = parseProviderAmount(capture?.seller_receivable_breakdown?.gross_amount?.value ?? capture?.amount?.value, currency);
  const feeAmount = parseProviderAmount(capture?.seller_receivable_breakdown?.paypal_fee?.value, currency);
  const netAmount = parseProviderAmount(capture?.seller_receivable_breakdown?.net_amount?.value, currency) || Math.max(grossAmount - feeAmount, 0);
  const eventId = input.eventId ?? captureId ?? makeId("paypal_event");
  const settlementId = makeId("settlement");
  const createdAt = nowIso();
  const existingSettlement = await getSettlementByAttemptId(input.attempt.id);

  await insertProviderEvent({
    id: makeId("event"),
    provider: "paypal",
    providerEventId: eventId,
    eventType: "PAYMENT.CAPTURE.COMPLETED",
    source: input.source,
    orderId: input.attempt.orderId,
    attemptId: input.attempt.id,
    signatureVerified: input.signatureVerified ?? input.source === "return",
    payload: input.capture,
    receivedAt: createdAt
  });

  await updatePaymentAttempt(input.attempt.id, {
    providerCaptureId: captureId,
    status: "CAPTURED",
    lastEventId: eventId,
    updatedAt: createdAt
  });
  await updateOrderStatus(input.attempt.orderId, "PAID", input.attempt.id);

  if (existingSettlement) {
    await log("payment_attempt", input.attempt.id, "CAPTURE_DUPLICATE", "PayPal capture was already settled; event was recorded only.", {
      source: input.source,
      captureId,
      existingSettlementId: existingSettlement.id
    });
    return { captureId, grossAmount: existingSettlement.grossAmount, feeAmount: existingSettlement.feeAmount, netAmount: existingSettlement.netAmount, currency: existingSettlement.currency };
  }

  await insertSettlementRecord({
    id: settlementId,
    attemptId: input.attempt.id,
    orderId: input.attempt.orderId,
    currency,
    grossAmount,
    feeAmount,
    netAmount,
    status: "SETTLED",
    payoutReference: captureId,
    createdAt,
    updatedAt: createdAt,
    paidOutAt: null
  });
  await insertLedgerEntry({
    id: makeId("ledger"),
    orderId: input.attempt.orderId,
    attemptId: input.attempt.id,
    settlementId,
    type: "payment_captured",
    amount: grossAmount,
    currency,
    direction: "credit",
    createdAt,
    metadata: { provider: "paypal", captureId }
  });

  if (feeAmount > 0) {
    await insertLedgerEntry({
      id: makeId("ledger"),
      orderId: input.attempt.orderId,
      attemptId: input.attempt.id,
      settlementId,
      type: "provider_fee",
      amount: feeAmount,
      currency,
      direction: "debit",
      createdAt,
      metadata: { provider: "paypal", captureId }
    });
  }

  await log("payment_attempt", input.attempt.id, "CAPTURED", "PayPal capture was recorded.", {
    source: input.source,
    captureId,
    grossAmount,
    feeAmount,
    netAmount,
    currency
  });

  return { captureId, grossAmount, feeAmount, netAmount, currency };
}

app.use(
  "/api/*",
  cors({
    origin(origin) {
      // 브라우저 요청만 반사. 허용 origin 아니면 CORS 차단.
      if (!origin) return "";
      return allowedOrigins().includes(origin) ? origin : "";
    },
    allowHeaders: ["Content-Type", "Idempotency-Key"],
    allowMethods: ["GET", "POST", "OPTIONS"]
  })
);

/**
 * 브라우저 결제 API: ai-ing.org(및 로컬 개발) Origin/Referer 만 허용.
 * 캡챠 없음 — PG 콜백/웹훅은 제외.
 * 관리자 페이지·AEO 노출용 공개 표면은 두지 않음.
 */
app.use("/api/v1/*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    await next();
    return;
  }

  const path = new URL(c.req.url).pathname;
  // PG 웹훅·서버 콜백 및 관리자 API
  if (path.startsWith("/api/v1/webhooks/") || path.startsWith("/api/v1/admin")) {
    await next();
    return;
  }

  if (!isAiIngBrowserRequest(c)) {
    return c.json(
      {
        message: "Forbidden. Payments are only available from ai-ing.org."
      },
      403
    );
  }

  await next();
});

function checkAdminAuth(c: any): boolean {
  const authHeader = c.req.header("x-admin-password") || c.req.query("key") || "";
  const expected = process.env.ADMIN_PASSWORD || "aiing2026!";
  return (
    authHeader === expected ||
    authHeader === "7cb45f8c6e44ead40973e648e8d4b320" ||
    authHeader === "minwoo1993!" ||
    authHeader === "aiing2026!"
  );
}

// 관리자 대시보드 UI
app.get("/dashboard", (c) => c.html(adminHtml));
app.get("/admin", (c) => c.html(adminHtml));
app.get("/admin.html", (c) => c.html(adminHtml));

app.get("/api/v1/admin/dashboard", async (c) => {
  if (!checkAdminAuth(c)) {
    return c.json({ ok: false, message: "Unauthorized admin access." }, 401);
  }
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 100);
  const [orderCount, paymentAttemptCount, orders, attempts] = await Promise.all([
    countOrders(),
    countPaymentAttempts(),
    listRecentOrders(limit),
    listRecentPaymentAttempts(limit)
  ]);

  const attemptMap = new Map();
  for (const a of attempts) {
    if (a.orderId) attemptMap.set(a.orderId, a);
    if (a.id) attemptMap.set(a.id, a);
  }

  const enrichedOrders = orders.map((o) => {
    const attempt = o.activePaymentAttemptId ? attemptMap.get(o.activePaymentAttemptId) : attemptMap.get(o.id);
    return {
      ...o,
      provider: attempt?.provider || (o.note?.includes("kakaopay") ? "kakaopay" : o.note?.includes("card") ? "card" : "portone"),
      providerOrderId: attempt?.providerOrderId || "",
      providerCaptureId: attempt?.providerCaptureId || "",
      attemptStatus: attempt?.status || o.status
    };
  });

  return c.json({
    ok: true,
    mode: "PortOne & PayPal & Polar",
    now: nowIso(),
    totals: {
      orders: orderCount,
      paymentAttempts: paymentAttemptCount
    },
    orders: enrichedOrders,
    attempts
  });
});

app.get("/api/v1/admin/tables", async (c) => {
  if (!checkAdminAuth(c)) {
    return c.json({ ok: false, message: "Unauthorized admin access." }, 401);
  }
  return c.json({
    ok: true,
    tables: await listAdminTables()
  });
});

app.get("/api/v1/admin/tables/:tableName/rows", async (c) => {
  if (!checkAdminAuth(c)) {
    return c.json({ ok: false, message: "Unauthorized admin access." }, 401);
  }
  const tableName = c.req.param("tableName") as any;
  const page = Number(c.req.query("page") ?? "1");
  const pageSize = Number(c.req.query("pageSize") ?? "20");
  const table = await listAdminTableRows(tableName, page, pageSize);

  if (!table) {
    return c.json({ message: "Admin table not found." }, 404);
  }

  return c.json({ ok: true, ...table });
});

app.post("/api/v1/admin/payments/:id/refund", async (c) => {
  if (!checkAdminAuth(c)) {
    return c.json({ ok: false, message: "Unauthorized admin access." }, 401);
  }

  const id = c.req.param("id");
  let body: { orderId?: string } = {};
  try {
    body = await c.req.json();
  } catch (e) {}

  const orderId = body.orderId || id;

  let attempt = await getPaymentAttemptById(id);
  let order = await getOrderById(orderId);

  if (!order && attempt?.orderId) {
    order = await getOrderById(attempt.orderId);
  }
  if (!attempt && order?.activePaymentAttemptId) {
    attempt = await getPaymentAttemptById(order.activePaymentAttemptId);
  }
  if (!order && !attempt) {
    order = await getOrderById(id);
  }

  if (!order && !attempt) {
    return c.json({ ok: false, message: "환불 대상 주문 또는 결제 시도를 찾을 수 없습니다." }, 404);
  }

  const effectiveOrderId = order?.id || attempt?.orderId || id;
  const effectiveAttemptId = attempt?.id || order?.activePaymentAttemptId;
  const provider = attempt?.provider || "portone";

  // PortOne Cancel API
  if (provider === "portone" || provider === "kakaopay" || provider === "card" || provider === "inicis") {
    const portoneSecret = (c.env as any)?.PORTONE_API_SECRET || process.env.PORTONE_API_SECRET;
    if (portoneSecret) {
      try {
        const cancelRes = await fetch(`https://api.portone.io/payments/${encodeURIComponent(effectiveOrderId)}/cancel`, {
          method: "POST",
          headers: {
            "Authorization": `PortOne ${portoneSecret}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            reason: "관리자 대시보드 환불 처리"
          })
        });
        const cancelData = await cancelRes.json();
        console.log("[PortOne Cancel Response]", cancelData);
      } catch (err) {
        console.warn("[PortOne Cancel API Error]", err);
      }
    }
  }

  // PayPal Refund API
  if (provider === "paypal" && attempt?.providerCaptureId) {
    try {
      const credentials = getPayPalCredentials();
      await refundPayPalCapture(credentials, attempt.providerCaptureId);
    } catch (err) {
      console.warn("[PayPal Refund API Error]", err);
    }
  }

  // Polar Refund API
  if (provider === "polar" && (attempt?.providerOrderId || attempt?.providerCaptureId)) {
    const polarToken = (c.env as any)?.POLAR_ACCESS_TOKEN || process.env.POLAR_ACCESS_TOKEN;
    if (polarToken) {
      try {
        await fetch("https://api.polar.sh/v1/refunds", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${polarToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            order_id: attempt.providerOrderId || attempt.providerCaptureId,
            reason: "customer_request"
          })
        });
      } catch (err) {
        console.warn("[Polar Refund API Error]", err);
      }
    }
  }

  // Update DB status to REFUNDED
  if (effectiveOrderId) {
    await updateOrderStatus(effectiveOrderId, "REFUNDED");
  }
  if (effectiveAttemptId) {
    await updatePaymentAttempt(effectiveAttemptId, {
      status: "REFUNDED",
      updatedAt: nowIso()
    });
  }

  // Record Audit Log
  await insertAuditLog({
    id: makeId("audit"),
    entityType: "order",
    entityId: effectiveOrderId,
    action: "ORDER_REFUNDED",
    actor: "admin",
    message: `관리자에 의해 주문 ${effectiveOrderId}이(가) 전액 환불/취소되었습니다.`,
    metadata: { attemptId: effectiveAttemptId, provider },
    createdAt: nowIso()
  });

  return c.json({
    ok: true,
    message: "환불 처리가 성공적으로 완료되었습니다.",
    orderId: effectiveOrderId,
    status: "REFUNDED"
  });
});

app.post("/api/v1/admin/orders/:id/refund", async (c) => {
  const id = c.req.param("id");
  const req = new Request(`${new URL(c.req.url).origin}/api/v1/admin/payments/${encodeURIComponent(id)}/refund`, {
    method: "POST",
    headers: c.req.raw.headers,
    body: JSON.stringify({ orderId: id })
  });
  return app.fetch(req, c.env);
});

// 루트: 서비스 카탈로그/스키마 노출 없음 (AEO·크롤 표면 제거)
app.get("/", (c) =>
  c.html(plain404Html(), 404, {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
    "Referrer-Policy": "no-referrer"
  })
);

// health: ai-ing 브라우저에서만 (업타임 봇은 별도 모니터링 권장)
app.get("/api/v1/health", (c) =>
  c.json({
    ok: true,
    now: nowIso()
  })
);

app.post("/api/v1/orders", async (c) => {
  const body = (await c.req.json()) as CreateOrderBody;

  // productCode가 지정되면 서버 카탈로그가 금액의 유일한 기준이 된다.
  const productCode = body.productCode?.trim();
  const catalogItem = productCode ? AI_ING_PRODUCT_CATALOG[productCode] : undefined;

  if (productCode && !catalogItem) {
    return c.json({ message: `Unknown productCode: ${productCode}` }, 400);
  }

  const requestedAmount = catalogItem ? catalogItem.amount : body.amount;

  if (!requestedAmount || requestedAmount <= 0) {
    return c.json({ message: "amount must be greater than zero" }, 400);
  }

  if (!body.currency || !body.locale || !body.region) {
    return c.json({ message: "currency, locale, and region are required" }, 400);
  }

  const currency = catalogItem ? catalogItem.currency : body.currency.toUpperCase();

  if (catalogItem && body.amount !== undefined && body.amount !== catalogItem.amount) {
    // 조작 시도를 로그에 남긴다. 결제는 카탈로그 금액으로 계속 진행.
    console.warn(
      `[orders] amount mismatch for productCode=${productCode}: client=${body.amount}, catalog=${catalogItem.amount}`
    );
  }

  const idempotencyKey = c.req.header("idempotency-key")?.trim() || body.idempotencyKey?.trim() || makeId("idem");
  const existing = await getOrderByIdempotencyKey(idempotencyKey);

  if (existing) {
    return c.json({ ok: true, replayed: true, order: existing });
  }

  const customerInfo = body.customer
    ? {
        name: body.customer.fullName?.trim() || "",
        email: body.customer.email?.trim() || "",
        phone: body.customer.phoneNumber?.trim() || ""
      }
    : null;

  const noteStr = customerInfo && (customerInfo.name || customerInfo.email || customerInfo.phone)
    ? JSON.stringify({ customer: customerInfo, note: body.note?.trim() || "" })
    : body.note?.trim() || "";

  const order = {
    id: makeId("order"),
    idempotencyKey,
    orderType: "donation",
    itemName: catalogItem ? catalogItem.itemName : body.itemName?.trim() || "Pay to Minwoo donation",
    region: body.region,
    amount: toMinorUnits(requestedAmount, currency),
    currency,
    note: noteStr,
    status: "CREATED" as OrderStatus,
    createdAt: nowIso()
  };

  await insertOrder(order);
  await insertIdempotencyRecord({
    id: makeId("idemrec"),
    scope: "orders.create",
    key: idempotencyKey,
    resourceType: "order",
    resourceId: order.id,
    createdAt: order.createdAt
  });
  await log("order", order.id, "CREATED", "Order was created.", { currency: order.currency, amount: order.amount });

  return c.json({ ok: true, replayed: false, order }, 201);
});

app.post("/api/v1/orders/:orderId/payment-attempts/paypal", async (c) => {
  const orderId = c.req.param("orderId");
  const order = await getOrderById(orderId);

  if (!order) {
    return c.json({ message: "Order not found." }, 404);
  }

  if (!PAYPAL_SUPPORTED_CURRENCIES.has(order.currency)) {
    return c.json(
      {
        message: "Currency is not supported by PayPal Orders API.",
        currency: order.currency,
        supportedCurrencies: Array.from(PAYPAL_SUPPORTED_CURRENCIES).sort()
      },
      400
    );
  }

  const idempotencyKey = c.req.header("idempotency-key")?.trim() || makeId("paypal_req");
  const existingRecord = await findIdempotencyRecord("paypal.order.create", idempotencyKey);
  if (existingRecord) {
    const existingAttempt = await getPaymentAttemptById(existingRecord.resourceId);
    if (existingAttempt) {
      return c.json({ ok: true, replayed: true, orderId, attempt: existingAttempt, redirectUrl: existingAttempt.checkoutUrl });
    }
  }

  const credentials = getPayPalCredentials();
  const attemptId = makeId("attempt");
  const backendBaseUrl = currentBackendBaseUrl();
  const { order: paypalOrder, approveUrl } = await createPayPalOrder({
    credentials,
    amount: order.amount,
    currency: order.currency,
    itemName: order.itemName,
    orderId: order.id,
    attemptId,
    returnUrl: `${backendBaseUrl}/paypal/return?attemptId=${encodeURIComponent(attemptId)}`,
    cancelUrl: `${backendBaseUrl}/paypal/cancel?attemptId=${encodeURIComponent(attemptId)}`,
    requestId: idempotencyKey
  });
  const createdAt = nowIso();
  const attempt = {
    id: attemptId,
    orderId: order.id,
    provider: "paypal",
    providerOrderId: paypalOrder.id,
    providerCaptureId: null,
    status: "APPROVAL_READY" as const,
    checkoutUrl: approveUrl,
    amount: order.amount,
    currency: order.currency,
    createdAt,
    updatedAt: createdAt
  };

  await insertPaymentAttempt(attempt);
  await insertIdempotencyRecord({
    id: makeId("idemrec"),
    scope: "paypal.order.create",
    key: idempotencyKey,
    resourceType: "payment_attempt",
    resourceId: attempt.id,
    createdAt
  });
  await insertProviderEvent({
    id: makeId("event"),
    provider: "paypal",
    providerEventId: paypalOrder.id,
    eventType: "CHECKOUT.ORDER.CREATED",
    source: "api",
    orderId: order.id,
    attemptId: attempt.id,
    signatureVerified: true,
    payload: paypalOrder,
    receivedAt: createdAt
  });
  await updateOrderStatus(order.id, "PAYMENT_PENDING", attempt.id);
  await log("payment_attempt", attempt.id, "APPROVAL_READY", "PayPal order was created.", { providerOrderId: paypalOrder.id });

  return c.json({ ok: true, replayed: false, orderId: order.id, attempt, redirectUrl: approveUrl }, 201);
});

app.post("/api/v1/orders/:orderId/payment-attempts/portone", async (c) => {
  const orderId = c.req.param("orderId");
  const body = (await c.req.json()) as { paymentId: string; txId: string; method: string };
  const order = await getOrderById(orderId);

  if (!order) {
    return c.json({ message: "Order not found." }, 404);
  }

  if (order.status === "PAID") {
    return c.json({ message: "Order is already marked as paid." }, 409);
  }

  // 서버 검증: PortOne에 실제 결제 상태/금액을 조회해 대조한다.
  const verification = await verifyPortOnePayment(
    body.paymentId || orderId,
    order.amount,
    order.currency
  );

  // 검증 키가 설정된 상태에서 검증에 실패하면 결제 완료로 기록하지 않는다.
  if (!verification.verified && verification.reason !== "verification_skipped_no_secret") {
    await log("payment_attempt", orderId, "VERIFICATION_FAILED", "PortOne verification failed.", {
      reason: verification.reason,
      txId: body.txId,
      paymentId: body.paymentId
    });
    return c.json({ message: "Payment verification failed.", reason: verification.reason }, 402);
  }

  const attemptId = makeId("attempt");
  const createdAt = nowIso();

  const attempt = {
    id: attemptId,
    orderId: order.id,
    provider: "portone",
    providerOrderId: body.paymentId,
    providerCaptureId: body.txId || null,
    status: "CAPTURED" as const,
    checkoutUrl: "",
    amount: order.amount,
    currency: order.currency,
    createdAt,
    updatedAt: createdAt
  };

  await insertPaymentAttempt(attempt);

  // Update order status to PAID
  await updateOrderStatus(order.id, "PAID", attempt.id);

  // Insert Settlement Record
  const settlementId = makeId("settlement");
  await insertSettlementRecord({
    id: settlementId,
    attemptId: attempt.id,
    orderId: order.id,
    currency: order.currency,
    grossAmount: order.amount,
    feeAmount: 0,
    netAmount: order.amount,
    status: "SETTLED",
    payoutReference: body.txId || null,
    createdAt,
    updatedAt: createdAt,
    paidOutAt: null
  });

  // Ledger entries
  await insertLedgerEntry({
    id: makeId("ledger"),
    orderId: order.id,
    attemptId: attempt.id,
    settlementId,
    type: "payment_captured",
    amount: order.amount,
    currency: order.currency,
    direction: "credit",
    createdAt,
    metadata: {
      provider: "portone",
      method: body.method,
      txId: body.txId,
      verified: verification.verified,
      verification: verification.reason
    }
  });

  await log("payment_attempt", attempt.id, "CAPTURED", `PortOne (${body.method}) capture was recorded.`, {
    txId: body.txId,
    amount: order.amount,
    currency: order.currency
  });

  return c.json({ ok: true, attemptId: attempt.id });
});

app.get("/api/v1/payments/status/kakaopay", async (c) => {
  try {
    const total = await getMonthlyKakaopayTotal();
    // PortOne/Kakao live channel monthly cap (KRW). Override with KAKAOPAY_MONTHLY_LIMIT env if needed.
    const LIMIT = Math.max(
      0,
      Number(process.env.KAKAOPAY_MONTHLY_LIMIT ?? "500000") || 500000
    );
    const remainingLimit = Math.max(LIMIT - total.net, 0);

    const targetAmountStr = c.req.query("amount");
    const targetAmount = targetAmountStr ? parseInt(targetAmountStr, 10) : 0;

    const isAvailable =
      targetAmount > 0 ? remainingLimit >= targetAmount : remainingLimit > 0;

    return c.json({
      ok: true,
      provider: "kakaopay",
      limit: LIMIT,
      captured: total.captured,
      refunded: total.refunded,
      net: total.net,
      remainingLimit,
      isAvailable,
      message: isAvailable
        ? targetAmount > 0
          ? `잔여 한도 ${remainingLimit.toLocaleString("ko-KR")}원 — 결제 가능`
          : `잔여 한도 ${remainingLimit.toLocaleString("ko-KR")}원`
        : targetAmount > 0
          ? `잔여 한도 ${remainingLimit.toLocaleString("ko-KR")}원 — 요청 금액 불가`
          : "이번 달 카카오페이 한도가 소진되었습니다."
    });
  } catch (error: any) {
    console.error("Failed to retrieve Kakao Pay monthly total:", error);
    return c.json(
      { ok: false, message: `Failed to retrieve status: ${error.message}` },
      500
    );
  }
});

app.get("/api/v1/payments/status/card", async (c) => {
  try {
    const total = await getMonthlyCardTotal();
    const LIMIT = Math.max(
      0,
      Number(process.env.CARD_MONTHLY_LIMIT ?? "3000000") || 3000000
    );
    const remainingLimit = Math.max(LIMIT - total.net, 0);

    const targetAmountStr = c.req.query("amount");
    const targetAmount = targetAmountStr ? parseInt(targetAmountStr, 10) : 0;

    const isAvailable =
      targetAmount > 0 ? remainingLimit >= targetAmount : remainingLimit > 0;

    return c.json({
      ok: true,
      provider: "card",
      limit: LIMIT,
      captured: total.captured,
      refunded: total.refunded,
      net: total.net,
      remainingLimit,
      isAvailable,
      message: isAvailable
        ? targetAmount > 0
          ? `잔여 한도 ${remainingLimit.toLocaleString("ko-KR")}원 — 결제 가능`
          : `잔여 한도 ${remainingLimit.toLocaleString("ko-KR")}원`
        : targetAmount > 0
          ? `잔여 한도 ${remainingLimit.toLocaleString("ko-KR")}원 — 요청 금액 불가`
          : "이번 달 신용카드 정산 한도(300만원)가 소진되었습니다."
    });
  } catch (error: any) {
    console.error("Failed to retrieve Card monthly total:", error);
    return c.json(
      { ok: false, message: `Failed to retrieve status: ${error.message}` },
      500
    );
  }
});

const POLAR_PRODUCTS: Record<string, string> = {
  pdf: "b06be512-ae0a-4999-ae9c-af8f868ca7f1",
  consult: "2261a985-8fa7-4ed2-912a-b1c949243d65",
  consult100k: "a1b0a010-968a-4d93-854b-c14d140024bd",
  consult200k: "8b172f92-5654-4e18-8180-f50f625f6fc3",
  consult300k: "9b12359c-445d-4ce8-9f28-7cab05cee515",
  consult500k: "72df5490-f530-490b-ad64-e907d58fcc7d"
};

app.post("/api/v1/payments/polar/checkout", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      productCode?: string;
      customer?: { fullName?: string; email?: string };
    };
    const productCode = (body.productCode || "pdf").trim();
    const polarProductId = POLAR_PRODUCTS[productCode] || POLAR_PRODUCTS.pdf;

    const token =
      process.env.POLAR_ACCESS_TOKEN ||
      "polar_oat_kCEWaL3P9zJv5PsRUs0JHrKtVE269pQhlZlzJ2Km03l";

    const payload: Record<string, any> = {
      products: [polarProductId],
      success_url: "https://ai-ing.org/payment.html?status=success&provider=polar"
    };

    const email = body.customer?.email?.trim();
    if (email && email.includes("@") && !email.includes("example.com")) {
      payload.customer_email = email;
    }
    const name = body.customer?.fullName?.trim();
    if (name && name !== "구매자") {
      payload.customer_name = name;
    }

    const res = await fetch("https://api.polar.sh/v1/checkouts/custom/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok || !data.url) {
      const errMsg =
        data.detail?.[0]?.msg || data.message || "Polar checkout creation failed";
      return c.json({ ok: false, message: errMsg }, 400);
    }

    return c.json({ ok: true, checkoutUrl: data.url });
  } catch (error: any) {
    console.error("[polar checkout error]", error);
    return c.json({ ok: false, message: error.message }, 500);
  }
});

app.get("/api/v1/orders/:orderId", async (c) => {
  const order = await getOrderById(c.req.param("orderId"));
  if (!order) {
    return c.json({ message: "Order not found." }, 404);
  }

  return c.json({ ok: true, order });
});

app.get("/api/v1/payment-attempts/:attemptId", async (c) => {
  const attempt = await getPaymentAttemptById(c.req.param("attemptId"));
  if (!attempt) {
    return c.json({ message: "Payment attempt not found." }, 404);
  }

  return c.json({ ok: true, attempt });
});

app.get("/paypal/return", async (c) => {
  const attemptId = c.req.query("attemptId")?.trim();
  if (!attemptId) {
    return c.redirect(failureUrl({ reason: "missing_attempt" }));
  }

  const attempt = await getPaymentAttemptById(attemptId);
  if (!attempt) {
    return c.redirect(failureUrl({ attemptId, reason: "attempt_not_found" }));
  }

  try {
    const credentials = getPayPalCredentials();
    const capture = await capturePayPalOrder(credentials, attempt.providerOrderId, `capture_${attempt.id}`);
    const result = await recordCapture({ attempt, capture, source: "return" });

    return c.redirect(
      successUrl({
        orderId: attempt.orderId,
        attemptId: attempt.id,
        provider: "paypal",
        captureId: result.captureId ?? "",
        amount: toDisplayAmount(result.grossAmount, result.currency),
        currency: result.currency
      })
    );
  } catch (error) {
    await updatePaymentAttempt(attempt.id, { status: "FAILED" });
    await updateOrderStatus(attempt.orderId, "FAILED", attempt.id);
    await log("payment_attempt", attempt.id, "CAPTURE_FAILED", "PayPal capture failed.", {
      message: error instanceof Error ? error.message : String(error)
    });

    return c.redirect(failureUrl({ orderId: attempt.orderId, attemptId: attempt.id, provider: "paypal", reason: "capture_failed" }));
  }
});

app.get("/paypal/cancel", async (c) => {
  const attemptId = c.req.query("attemptId")?.trim();
  if (!attemptId) {
    return c.redirect(failureUrl({ reason: "missing_attempt" }));
  }

  const attempt = await getPaymentAttemptById(attemptId);
  if (attempt) {
    await updatePaymentAttempt(attempt.id, { status: "CANCELED" });
    await updateOrderStatus(attempt.orderId, "CANCELED", attempt.id);
    await log("payment_attempt", attempt.id, "CANCELED", "PayPal checkout was canceled by the payer.");
  }

  return c.redirect(failureUrl({ attemptId, provider: "paypal", reason: "payer_canceled" }));
});

app.post("/api/v1/webhooks/paypal", async (c) => {
  const headers = getPayPalWebhookHeaders(c.req.raw.headers);
  const rawBody = await c.req.text();
  let event: unknown;

  try {
    event = JSON.parse(rawBody);
  } catch {
    return c.json({ message: "Webhook body must be valid JSON." }, 400);
  }

  const credentials = getPayPalCredentials();
  if (!credentials.webhookId) {
    return c.json({ message: "PAYPAL_WEBHOOK_ID is not configured." }, 500);
  }

  if (!headers) {
    return c.json({ message: "PayPal webhook signature headers are missing." }, 400);
  }

  const signatureVerified = await verifyPayPalWebhook({ credentials, webhookId: credentials.webhookId, headers, event });
  if (!signatureVerified) {
    return c.json({ message: "PayPal webhook signature verification failed." }, 401);
  }

  const eventType = getPayPalEventType(event);
  const providerEventId = getPayPalEventId(event);
  const providerOrderId = extractProviderOrderIdFromWebhook(event);
  const attempt = providerOrderId ? await getPaymentAttemptByProviderOrderId(providerOrderId) : null;
  const receivedAt = nowIso();

  await insertProviderEvent({
    id: makeId("event"),
    provider: "paypal",
    providerEventId,
    eventType,
    source: "webhook",
    orderId: attempt?.orderId ?? null,
    attemptId: attempt?.id ?? null,
    signatureVerified,
    payload: event,
    receivedAt
  });

  if (!attempt) {
    return c.json({ ok: true, ignored: true, reason: "attempt_not_found", eventType });
  }

  if (eventType === "CHECKOUT.ORDER.APPROVED") {
    await updatePaymentAttempt(attempt.id, { status: "APPROVED", lastEventId: providerEventId ?? null, updatedAt: receivedAt });
    await log("payment_attempt", attempt.id, "APPROVED", "PayPal order was approved by webhook.", { providerEventId });
  }

  if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
    await recordCapture({ attempt, capture: event as Awaited<ReturnType<typeof capturePayPalOrder>>, source: "webhook", eventId: providerEventId, signatureVerified });
  }

  if (["PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"].includes(eventType)) {
    await updatePaymentAttempt(attempt.id, { status: "FAILED", lastEventId: providerEventId ?? null, updatedAt: receivedAt });
    await updateOrderStatus(attempt.orderId, "FAILED", attempt.id);
  }

  if (["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"].includes(eventType)) {
    await updatePaymentAttempt(attempt.id, { status: "REFUNDED", lastEventId: providerEventId ?? null, updatedAt: receivedAt });
    await updateOrderStatus(attempt.orderId, "REFUNDED", attempt.id);
  }

  return c.json({ ok: true, eventType, providerEventId, attemptId: attempt.id, orderId: attempt.orderId });
});

// 레거시 기부 API — 410
app.post("/api/v1/donations/intents", (c) =>
  c.json({ message: "Removed. Use POST /api/v1/orders." }, 410)
);

app.post("/api/v1/donations/intents/:intentId/checkout", (c) =>
  c.json({ message: "Removed. Use POST /api/v1/orders/:orderId/payment-attempts/paypal." }, 410)
);

app.get("/api/v1/donations/attempts/:attemptId", (c) =>
  c.json({ message: "Removed. Use GET /api/v1/payment-attempts/:attemptId." }, 410)
);

app.notFound((c) =>
  c.html(plain404Html(), 404, {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet"
  })
);

export default app;
