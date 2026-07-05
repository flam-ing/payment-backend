export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  const cookieHeader = request.headers.get("Cookie") || "";
  const sessionCookieName = "payment-auth";
  const expectedToken = "verified";
  const CORRECT_PASSWORD = env.SLIDES_PASSWORD || "3633"; // Use 3633 as default
  
  // Check if session cookie matches
  const isAuthenticated = cookieHeader.includes(`${sessionCookieName}=${expectedToken}`);
  
  // 1. Map virtual /admin folder path to /admin.html file internally
  const isAdminRoute = url.pathname === "/admin" || url.pathname === "/admin.html";
  
  // 2. Handle admin login POST request
  if (request.method === "POST" && url.pathname === "/admin/login") {
    try {
      const formData = await request.formData();
      const password = formData.get("password");
      const to = url.searchParams.get("to") || "/admin";
      
      if (password === CORRECT_PASSWORD) {
        return new Response(null, {
          status: 302,
          headers: {
            "Location": to,
            "Set-Cookie": `${sessionCookieName}=${expectedToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`, // 30 days
          },
        });
      } else {
        return renderLoginPage("비밀번호가 올바르지 않습니다.", to);
      }
    } catch (e) {
      return new Response("Invalid form submission", { status: 400 });
    }
  }
  
  // 3. Protect /admin and /admin.html
  if (isAdminRoute) {
    if (!isAuthenticated) {
      return renderLoginPage("", url.pathname + url.search);
    }
    
    // If authenticated, /admin serves the admin.html file contents
    if (url.pathname === "/admin") {
      url.pathname = "/admin.html";
      return context.next(new Request(url.toString(), request));
    }
  }
  
  return context.next();
}

function renderLoginPage(errorMessage = "", redirectUrl = "/admin") {
  const errorHtml = errorMessage 
    ? `<div class="error-msg"><i class="fa-solid fa-triangle-exclamation"></i> ${errorMessage}</div>` 
    : "";
    
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>에이아잉 결제 어드민 - 로그인</title>
  
  <!-- Fonts & Icons -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=Noto+Sans+KR:wght@300;400;500;700;900&family=Outfit:wght@400;600;800;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  
  <style>
    :root {
      --bg-dark: #070a13;
      --bg-card: rgba(17, 24, 39, 0.7);
      --border-color: rgba(255, 255, 255, 0.08);
      
      --color-primary: #ec4899; /* Pink */
      --color-secondary: #8b5cf6; /* Violet */
      
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      --font-korean: 'Noto Sans KR', sans-serif;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-dark);
      color: var(--text-main);
      font-family: var(--font-korean);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      position: relative;
      overflow: hidden;
    }

    /* Background Neon Orbs */
    .bg-orbs {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: -2;
      overflow: hidden;
      pointer-events: none;
    }

    .orb {
      position: absolute;
      border-radius: 50%;
      filter: blur(150px);
      opacity: 0.15;
    }

    .orb-1 {
      top: -20%;
      left: -10%;
      width: 60vw;
      height: 60vw;
      background: radial-gradient(circle, var(--color-primary) 0%, transparent 70%);
    }

    .orb-2 {
      bottom: -20%;
      right: -10%;
      width: 60vw;
      height: 60vw;
      background: radial-gradient(circle, var(--color-secondary) 0%, transparent 70%);
    }

    /* Grid Overlay */
    .bg-grid {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-image: 
        linear-gradient(rgba(255, 255, 255, 0.015) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.015) 1px, transparent 1px);
      background-size: 50px 50px;
      z-index: -1;
      pointer-events: none;
    }

    .login-container {
      width: 100%;
      max-width: 420px;
      padding: 20px;
    }

    .login-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 24px;
      padding: 45px 35px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(16px);
      display: flex;
      flex-direction: column;
      gap: 25px;
      text-align: center;
    }

    .logo-area {
      display: flex;
      flex-direction: column;
      gap: 12px;
      align-items: center;
    }

    .logo-icon {
      width: 64px;
      height: 64px;
      border-radius: 20px;
      background: linear-gradient(135deg, var(--color-primary), var(--color-secondary));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.8rem;
      color: #ffffff;
      box-shadow: 0 8px 20px rgba(236, 72, 153, 0.3);
    }

    h1 {
      font-size: 1.45rem;
      font-weight: 900;
      background: linear-gradient(135deg, #ffffff 60%, var(--text-muted));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-top: 8px;
      letter-spacing: -0.5px;
    }

    p {
      font-size: 0.88rem;
      color: var(--text-muted);
      line-height: 1.5;
    }

    form {
      display: flex;
      flex-direction: column;
      gap: 15px;
      margin-top: 10px;
    }

    .input-group {
      position: relative;
    }

    .input-group i {
      position: absolute;
      left: 18px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      font-size: 1rem;
    }

    input[type="password"] {
      width: 100%;
      padding: 15px 15px 15px 50px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      color: #ffffff;
      font-size: 1rem;
      transition: all 0.3s ease;
    }

    input[type="password"]:focus {
      outline: none;
      border-color: var(--color-primary);
      background: rgba(255, 255, 255, 0.06);
      box-shadow: 0 0 10px rgba(236, 72, 153, 0.25);
    }

    button {
      padding: 15px;
      border: none;
      border-radius: 12px;
      background: linear-gradient(90deg, var(--color-primary), var(--color-secondary));
      color: #ffffff;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 6px 15px rgba(236, 72, 153, 0.15);
      transition: all 0.3s ease;
    }

    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(236, 72, 153, 0.3);
    }

    button:active {
      transform: translateY(0);
    }

    .error-msg {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.2);
      color: #f87171;
      padding: 12px;
      border-radius: 10px;
      font-size: 0.85rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
  </style>
</head>
<body>
  <div class="bg-orbs">
    <div class="orb orb-1"></div>
    <div class="orb orb-2"></div>
  </div>
  <div class="bg-grid"></div>
  
  <div class="login-container">
    <div class="login-card">
      <div class="logo-area">
        <div class="logo-icon"><i class="fa-solid fa-gauge"></i></div>
        <h1>결제 모니터링 시스템</h1>
        <p>어드민 대시보드 데이터에 접근하려면<br>비밀번호를 입력하세요.</p>
      </div>
      
      ${errorHtml}
      
      <form action="/admin/login?to=${encodeURIComponent(redirectUrl)}" method="POST">
        <div class="input-group">
          <i class="fa-solid fa-key"></i>
          <input type="password" name="password" placeholder="비밀번호 입력" required autofocus>
        </div>
        <button type="submit">로그인</button>
      </form>
    </div>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}
