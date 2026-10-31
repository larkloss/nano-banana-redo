// The only pages a signed-out visitor can see. Self-contained (no assets),
// styled to match the app's warm light theme.

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    font-family: "Google Sans Text", "Segoe UI", system-ui, -apple-system, sans-serif;
    background: #f8f4ec; color: #2e2822; }
  .card { width: 100%; max-width: 360px; background: #fff; border: 1px solid #ede6da; border-radius: 24px;
    padding: 28px 24px; box-shadow: 0 1px 2px rgb(60 40 20 / .05), 0 4px 16px rgb(60 40 20 / .06); }
  .logo { width: 48px; height: 48px; border-radius: 16px; background: #fdecc8; display: grid; place-items: center;
    font-size: 24px; margin-bottom: 14px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { font-size: 13px; color: #776c5f; margin: 0 0 18px; line-height: 1.5; }
  label { display: block; font-size: 12px; font-weight: 600; color: #5f5549; margin-bottom: 6px; }
  input { width: 100%; font: inherit; font-size: 15px; padding: 11px 14px; border-radius: 14px;
    border: 1px solid #e0d6c7; background: #f8f4ec; color: inherit; outline: none; }
  input:focus { border-color: #7b66f2; background: #fff; }
  button { width: 100%; margin-top: 14px; font: inherit; font-size: 14px; font-weight: 600; color: #fff;
    background: #6550e6; border: 0; border-radius: 999px; padding: 11px; cursor: pointer; }
  button:hover { background: #7b66f2; }
  .error { font-size: 12px; color: #b91c1c; background: #fef2f2; border-radius: 12px; padding: 8px 12px;
    margin: 0 0 14px; }
  @media (prefers-color-scheme: dark) {
    body { background: #141217; color: #e4e4e7; }
    .card { background: #1d1a21; border-color: #2b2730; box-shadow: none; }
    .logo { background: #3a2f17; }
    p, label { color: #a1a1aa; }
    input { background: #141217; border-color: #3b3641; }
    input:focus { background: #141217; }
    .error { background: #3b1414; color: #fca5a5; }
  }
`

const ERRORS: Record<string, string> = {
  wrong: 'That password isn’t right. Try again.',
  locked: 'Too many wrong tries from this network. Wait 15 minutes, then try again.',
}

export function loginPage({ next, error }: { next: string; error: string | null }): Response {
  const message = error ? ERRORS[error] : undefined
  return html(
    200,
    `<form class="card" method="post" action="/login">
      <div class="logo">🍌</div>
      <h1>Nano Banana Studio</h1>
      <p>This studio is private. Enter the password to continue.</p>
      ${message ? `<div class="error" role="alert">${escapeHtml(message)}</div>` : ''}
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <button type="submit">Unlock</button>
    </form>`,
  )
}

export function messagePage(title: string, body: string, status: number): Response {
  return html(
    status,
    `<div class="card"><div class="logo">🍌</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></div>`,
  )
}

function html(status: number, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Nano Banana Studio</title><style>${STYLE}</style></head><body>${body}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
