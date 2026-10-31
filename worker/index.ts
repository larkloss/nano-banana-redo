import { DurableObject } from 'cloudflare:workers'
import { loginPage, messagePage } from './pages'

// ---------------------------------------------------------------------------
// Password-protected host for the Nano Banana apps.
//
// Nothing is served without a valid session cookie: strangers only ever see
// the login form. The session is an HMAC-signed expiry time keyed by the
// password itself, so changing APP_PASSWORD signs every device out.
//
// /api/* is the sync backend the apps talk to (src/lib/cloud.ts). It stores
// named values (the apps' localStorage entries and reference-photo lists) and
// the reference photos' bytes. API keys are refused by name on the server as
// well as never being sent by the client.
// ---------------------------------------------------------------------------

export interface Env {
  ASSETS: Fetcher
  SYNC: DurableObjectNamespace<SyncStore>
  APP_PASSWORD?: string
}

const COOKIE = 'nbr_session'
const SESSION_DAYS = 30
const MIN_PASSWORD_LENGTH = 8
// Login lockout: this many wrong passwords from one IP within the window
const MAX_FAILURES = 10
const FAILURE_WINDOW_MS = 15 * 60 * 1000

// What the store accepts. App data uses the apps' own localStorage names;
// reference-photo lists are "refs:<slot>".
const KEY_PATTERN = /^(?:nbr\.[A-Za-z0-9._-]{1,80}|refs:[A-Za-z0-9_-]{1,40})$/
const SECRET_KEY_PATTERN = /api.?key/i
const BLOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/
// Durable Object values max out at 2 MiB; stay well under it
const MAX_VALUE_CHARS = 1_500_000
const BLOB_CHUNK_BYTES = 1024 * 1024
const MAX_BLOB_BYTES = 40 * 1024 * 1024
// An uploaded photo isn't collected until it has had time to be listed —
// the client uploads first, then pushes the list that references it
const BLOB_GRACE_MS = 60 * 60 * 1000

const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Strict-Transport-Security': 'max-age=31536000',
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return secure(await route(request, env))
  },
} satisfies ExportedHandler<Env>

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const password = env.APP_PASSWORD ?? ''
  // Fail closed: no (or a trivially short) password means nothing is served
  if (password.length < MIN_PASSWORD_LENGTH) {
    return messagePage(
      'Not set up yet',
      `Set the APP_PASSWORD secret (at least ${MIN_PASSWORD_LENGTH} characters) for this Worker, then reload. See DEPLOY.md.`,
      503,
    )
  }
  const key = await sessionKey(password)
  const authed = await hasValidSession(request, key)

  if (url.pathname === '/login') {
    if (request.method === 'POST') return login(request, env, password, key)
    if (authed) return redirect(safeNext(url.searchParams.get('next')))
    return loginPage({ next: safeNext(url.searchParams.get('next')), error: url.searchParams.get('e') })
  }
  if (url.pathname === '/logout') {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    return redirect('/login', { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` })
  }

  if (url.pathname.startsWith('/api/')) {
    if (!authed) return json({ error: 'signed-out' }, 401)
    return api(request, env, url)
  }

  if (!authed) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Unauthorized', { status: 401 })
    return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`)
  }
  // Revalidated on every load (so the password check always runs) but a
  // 304 keeps it cheap; never stored by shared caches
  const asset = await env.ASSETS.fetch(request)
  const out = new Response(asset.body, asset)
  out.headers.set('Cache-Control', 'private, no-cache')
  return out
}

// ---------------------------------------------------------------------------
// Sessions and login
// ---------------------------------------------------------------------------

async function login(request: Request, env: Env, password: string, key: CryptoKey): Promise<Response> {
  const form = await request.formData().catch(() => null)
  const next = safeNext(typeof form?.get('next') === 'string' ? (form.get('next') as string) : null)
  const attempt = typeof form?.get('password') === 'string' ? (form.get('password') as string) : ''
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const store = syncStore(env)

  const gate = await store.loginGate(ip, Date.now())
  if (!gate.allowed) return redirect(`/login?e=locked&next=${encodeURIComponent(next)}`)

  if (!(await passwordsMatch(attempt, password))) {
    await store.loginFailed(ip, Date.now())
    // A little friction for guessing scripts; harmless for a typo
    await new Promise((resolve) => setTimeout(resolve, 600))
    return redirect(`/login?e=wrong&next=${encodeURIComponent(next)}`)
  }

  await store.loginSucceeded(ip)
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  const token = `${expires}.${await sign(key, `session:${expires}`)}`
  return redirect(next, {
    'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}; HttpOnly; Secure; SameSite=Strict`,
  })
}

async function hasValidSession(request: Request, key: CryptoKey): Promise<boolean> {
  const cookie = request.headers.get('Cookie') ?? ''
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9]+)\\.([A-Za-z0-9_-]+)`))
  if (!match) return false
  const expires = Number(match[1])
  if (!Number.isFinite(expires) || expires < Date.now()) return false
  return constantTimeEqual(match[2], await sign(key, `session:${expires}`))
}

async function sessionKey(password: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`nbr-session-v1:${password}`))
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

async function sign(key: CryptoKey, message: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return base64url(new Uint8Array(mac))
}

// Compares fixed-length digests so the time taken says nothing about the password
async function passwordsMatch(attempt: string, password: string): Promise<boolean> {
  const [a, b] = await Promise.all(
    [attempt, password].map((s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))),
  )
  return crypto.subtle.timingSafeEqual(a, b)
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  if (x.byteLength !== y.byteLength) return false
  return crypto.subtle.timingSafeEqual(x, y)
}

// Only same-site paths — never an absolute or protocol-relative URL
function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  if (next.startsWith('/login') || next.startsWith('/logout')) return '/'
  return next
}

// ---------------------------------------------------------------------------
// Sync API
// ---------------------------------------------------------------------------

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const store = syncStore(env)
  const isWrite = request.method !== 'GET' && request.method !== 'HEAD'
  // Writes must come from the app itself: the custom header can't be sent
  // cross-site without a CORS preflight, which this Worker never approves
  if (isWrite) {
    const origin = request.headers.get('Origin')
    if (request.headers.get('X-NBR') !== '1' || (origin !== null && origin !== url.origin)) {
      return json({ error: 'forbidden' }, 403)
    }
  }

  if (url.pathname === '/api/snapshot' && request.method === 'GET') {
    return json(await store.snapshot())
  }

  if (url.pathname === '/api/push' && request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as PushBody | null
    const problem = validatePush(body)
    if (problem) return json({ error: problem }, 400)
    const result = await store.push(body!.changes, body!.force === true, Date.now())
    return json(result, result.ok ? 200 : 409)
  }

  const blobMatch = url.pathname.match(/^\/api\/blob\/([^/]+)$/)
  if (blobMatch) {
    const id = blobMatch[1]
    if (!BLOB_ID_PATTERN.test(id)) return json({ error: 'bad id' }, 400)
    if (request.method === 'GET') {
      const blob = await store.getBlob(id)
      if (!blob) return json({ error: 'not found' }, 404)
      return new Response(blob.bytes, { headers: { 'Content-Type': blob.mimeType } })
    }
    if (request.method === 'PUT') {
      const mimeType = request.headers.get('Content-Type') ?? ''
      if (!/^image\/[a-z0-9.+-]+$/i.test(mimeType)) return json({ error: 'images only' }, 415)
      const bytes = await request.arrayBuffer()
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_BLOB_BYTES) return json({ error: 'bad size' }, 413)
      await store.putBlob(id, mimeType, bytes, Date.now())
      return json({ ok: true })
    }
  }

  return json({ error: 'not found' }, 404)
}

interface PushChange {
  value: string | null
  base: number
}
interface PushBody {
  changes: Record<string, PushChange>
  force?: boolean
}

function validatePush(body: PushBody | null): string | null {
  if (!body || typeof body !== 'object' || !body.changes || typeof body.changes !== 'object') return 'bad body'
  const entries = Object.entries(body.changes)
  if (entries.length === 0 || entries.length > 100) return 'bad change count'
  for (const [name, change] of entries) {
    if (!KEY_PATTERN.test(name)) return `bad key ${name}`
    // Defence in depth: API keys must never be stored, whatever the client does
    if (SECRET_KEY_PATTERN.test(name)) return `refusing to store ${name}`
    if (!change || typeof change !== 'object' || typeof change.base !== 'number') return `bad change ${name}`
    if (change.value !== null && typeof change.value !== 'string') return `bad value ${name}`
    if (typeof change.value === 'string' && change.value.length > MAX_VALUE_CHARS) return `${name} is too large`
  }
  return null
}

function syncStore(env: Env): DurableObjectStub<SyncStore> {
  return env.SYNC.get(env.SYNC.idFromName('default'))
}

// ---------------------------------------------------------------------------
// Storage: one Durable Object holds everything, which makes every push an
// atomic compare-and-set across all the keys in it.
// ---------------------------------------------------------------------------

interface StoredValue {
  // null = deleted (kept as a tombstone so its version still counts)
  value: string | null
  version: number
}

interface BlobMeta {
  mimeType: string
  size: number
  chunks: number
  createdAt: number
}

export type PushResult =
  | { ok: true; versions: Record<string, number> }
  | { ok: false; conflicts: Record<string, StoredValue> }

export class SyncStore extends DurableObject<Env> {
  async snapshot(): Promise<{ keys: Record<string, StoredValue> }> {
    const rows = await this.ctx.storage.list<StoredValue>({ prefix: 'k:' })
    const keys: Record<string, StoredValue> = {}
    for (const [k, v] of rows) keys[k.slice(2)] = v
    return { keys }
  }

  // Per-key optimistic concurrency: a change applies only if the client saw
  // the current version of that key. Otherwise nothing is written and the
  // current values come back so the client can show the conflict.
  async push(changes: Record<string, PushChange>, force: boolean, now: number): Promise<PushResult> {
    const names = Object.keys(changes)
    const current = await this.ctx.storage.get<StoredValue>(names.map((n) => `k:${n}`))
    if (!force) {
      const conflicts: Record<string, StoredValue> = {}
      for (const name of names) {
        const existing = current.get(`k:${name}`)
        // Writing what's already there is never a conflict (two devices
        // saving the same normalised settings, a retried push, …)
        const sameValue = (existing?.value ?? null) === changes[name].value
        if ((existing?.version ?? 0) !== changes[name].base && !sameValue) {
          conflicts[name] = existing ?? { value: null, version: 0 }
        }
      }
      if (Object.keys(conflicts).length > 0) return { ok: false, conflicts }
    }

    const counter = ((await this.ctx.storage.get<number>('meta:counter')) ?? 0) + 1
    const writes: Record<string, unknown> = { 'meta:counter': counter }
    const versions: Record<string, number> = {}
    for (const name of names) {
      writes[`k:${name}`] = { value: changes[name].value, version: counter } satisfies StoredValue
      versions[name] = counter
    }
    await this.ctx.storage.put(writes)
    if (names.some((n) => n.startsWith('refs:'))) await this.collectBlobs(now)
    return { ok: true, versions }
  }

  async putBlob(id: string, mimeType: string, bytes: ArrayBuffer, now: number): Promise<void> {
    await this.deleteBlob(id)
    const chunks = Math.ceil(bytes.byteLength / BLOB_CHUNK_BYTES)
    const writes: Record<string, unknown> = {}
    for (let i = 0; i < chunks; i++) {
      writes[`b:${id}:${i}`] = bytes.slice(i * BLOB_CHUNK_BYTES, (i + 1) * BLOB_CHUNK_BYTES)
    }
    writes[`bm:${id}`] = { mimeType, size: bytes.byteLength, chunks, createdAt: now } satisfies BlobMeta
    await this.ctx.storage.put(writes)
  }

  async getBlob(id: string): Promise<{ mimeType: string; bytes: ArrayBuffer } | null> {
    const meta = await this.ctx.storage.get<BlobMeta>(`bm:${id}`)
    if (!meta) return null
    const keys = Array.from({ length: meta.chunks }, (_, i) => `b:${id}:${i}`)
    const parts = await this.ctx.storage.get<ArrayBuffer>(keys)
    const out = new Uint8Array(meta.size)
    let offset = 0
    for (const k of keys) {
      const part = parts.get(k)
      if (!part) return null
      out.set(new Uint8Array(part), offset)
      offset += part.byteLength
    }
    return { mimeType: meta.mimeType, bytes: out.buffer }
  }

  // Deletes photos no list mentions any more (old enough to not be mid-upload)
  private async collectBlobs(now: number): Promise<void> {
    const lists = await this.ctx.storage.list<StoredValue>({ prefix: 'k:refs:' })
    const referenced = new Set<string>()
    for (const [, stored] of lists) {
      if (!stored.value) continue
      try {
        for (const item of JSON.parse(stored.value) as { id?: unknown }[]) {
          if (typeof item?.id === 'string') referenced.add(item.id)
        }
      } catch {
        // a malformed list keeps everything — never delete on doubt
        return
      }
    }
    const metas = await this.ctx.storage.list<BlobMeta>({ prefix: 'bm:' })
    for (const [k, meta] of metas) {
      const id = k.slice(3)
      if (!referenced.has(id) && now - meta.createdAt > BLOB_GRACE_MS) await this.deleteBlob(id)
    }
  }

  private async deleteBlob(id: string): Promise<void> {
    const meta = await this.ctx.storage.get<BlobMeta>(`bm:${id}`)
    if (!meta) return
    const keys = Array.from({ length: meta.chunks }, (_, i) => `b:${id}:${i}`)
    await this.ctx.storage.delete([...keys, `bm:${id}`])
  }

  // --- login lockout, per client IP ---------------------------------------

  async loginGate(ip: string, now: number): Promise<{ allowed: boolean }> {
    const record = await this.ctx.storage.get<{ count: number; since: number }>(`fail:${ip}`)
    if (!record || now - record.since > FAILURE_WINDOW_MS) return { allowed: true }
    return { allowed: record.count < MAX_FAILURES }
  }

  async loginFailed(ip: string, now: number): Promise<void> {
    const key = `fail:${ip}`
    const record = await this.ctx.storage.get<{ count: number; since: number }>(key)
    const fresh = !record || now - record.since > FAILURE_WINDOW_MS
    await this.ctx.storage.put(key, fresh ? { count: 1, since: now } : { count: record.count + 1, since: record.since })
  }

  async loginSucceeded(ip: string): Promise<void> {
    await this.ctx.storage.delete(`fail:${ip}`)
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-NBR-Cloud': '1' },
  })
}

function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...extra } })
}

function secure(response: Response): Response {
  const out = new Response(response.body, response)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value)
  if (!out.headers.has('Cache-Control')) out.headers.set('Cache-Control', 'no-store')
  return out
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
