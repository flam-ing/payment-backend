/**
 * (Optional Cloudflare Pages attach) — payment host is primarily Vercel.
 * No captcha. No admin. No public index. No AEO surface.
 */
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // Always hide admin
  if (
    path === "/admin" ||
    path === "/admin.html" ||
    path === "/dashboard" ||
    path.startsWith("/dashboard/") ||
    path.startsWith("/admin/")
  ) {
    return plain404();
  }

  // API: only ai-ing origins (except webhooks)
  if (path.startsWith("/api/")) {
    if (path.startsWith("/api/v1/webhooks/")) {
      return context.next();
    }
    if (path.startsWith("/api/v1/admin")) {
      return plain404();
    }
    const origin = request.headers.get("Origin") || "";
    let refOrigin = "";
    try {
      const ref = request.headers.get("Referer");
      if (ref) refOrigin = new URL(ref).origin;
    } catch {
      /* ignore */
    }
    const allowed = new Set([
      "https://ai-ing.org",
      "https://www.ai-ing.org",
      "https://ai-ing-6lf.pages.dev",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:4173"
    ]);
    if (request.method !== "OPTIONS" && !allowed.has(origin) && !allowed.has(refOrigin)) {
      return new Response(JSON.stringify({ message: "Forbidden. Payments are only available from ai-ing.org." }), {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          "X-Robots-Tag": "noindex, nofollow",
          "Cache-Control": "private, no-store"
        }
      });
    }
    return context.next();
  }

  // Root & other HTML → 404
  if (path === "/" || path === "/index.html") {
    return plain404();
  }

  return context.next();
}

function plain404() {
  const body = `<!DOCTYPE html>
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
  return new Response(body, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer"
    }
  });
}
