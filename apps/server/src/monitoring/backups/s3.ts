/**
 * Minimal S3-compatible client: AWS Signature V4 with node:crypto + fetch. No SDK.
 *
 * - Path-style URLs (`<endpoint>/<bucket>/<key>`) so it works with AWS, MinIO, Cloudflare R2,
 *   Backblaze B2, Wasabi, Hetzner and friends.
 * - Big uploads never pass through Docksy: `presignUrl('PUT', …)` produces a short-lived URL and the
 *   server runs `curl -T` against it, streaming the file straight from the VPS to the bucket.
 * - PUT (small bodies), DELETE and LIST (v2) are signed with headers from the control plane.
 */
import { createHash, createHmac } from 'node:crypto';

export interface S3Config {
  endpoint: string; // https://s3.us-east-1.amazonaws.com, https://<acct>.r2.cloudflarestorage.com, http://minio:9000
  bucket: string;
  region: string; // "us-east-1"; R2 uses "auto"
  accessKey: string;
  secretKey: string;
  prefix: string; // "docksy/" — may be empty
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 percent-encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone). */
export const rfc3986 = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

/** Encode an object key for the URL path: every segment encoded, slashes kept. */
export const encodeKey = (key: string): string => key.split('/').map(rfc3986).join('/');

/** 20150830T123600Z */
export const amzDate = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');

export function canonicalQuery(params: Array<[string, string]>): string {
  return params
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export function signingKey(secretKey: string, date8: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date8), region), service), 'aws4_request');
}

export interface SignInput {
  method: string;
  url: string;
  region: string;
  service?: string; // default "s3"
  accessKey: string;
  secretKey: string;
  /** Extra headers to sign (host and x-amz-date are added automatically). */
  headers?: Record<string, string>;
  /** Hex sha256 of the body, or "UNSIGNED-PAYLOAD". Default: hash of the empty body. */
  payloadHash?: string;
  /** Add x-amz-content-sha256 (S3 requires it; the generic AWS test suite does not use it). */
  contentSha256Header?: boolean;
  date?: Date;
}

export interface Signed {
  headers: Record<string, string>; // everything to send, including authorization
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/** Sign a request with SigV4 using the Authorization header. */
export function signRequest(i: SignInput): Signed {
  const u = new URL(i.url);
  const service = i.service ?? 's3';
  const date = amzDate(i.date ?? new Date());
  const date8 = date.slice(0, 8);
  const payloadHash = i.payloadHash ?? EMPTY_SHA256;

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers ?? {})) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  headers.host = u.host;
  headers['x-amz-date'] = date;
  if (i.contentSha256Header) headers['x-amz-content-sha256'] = payloadHash;

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const canonicalRequest = [
    i.method.toUpperCase(),
    u.pathname || '/',
    canonicalQuery([...u.searchParams]),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${date8}/${i.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(i.secretKey, date8, i.region, service)).update(stringToSign).digest('hex');

  const out: Record<string, string> = { ...headers };
  delete out.host; // fetch sets it
  out.authorization = `AWS4-HMAC-SHA256 Credential=${i.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: out, canonicalRequest, stringToSign, signature };
}

export interface PresignInput {
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  url: string;
  region: string;
  service?: string;
  accessKey: string;
  secretKey: string;
  expiresSec?: number; // default 3600, max 604800
  date?: Date;
}

/** Query-string (presigned) SigV4 URL. Only `host` is signed; the payload is UNSIGNED-PAYLOAD. */
export function presignUrl(i: PresignInput): string {
  const u = new URL(i.url);
  const service = i.service ?? 's3';
  const date = amzDate(i.date ?? new Date());
  const date8 = date.slice(0, 8);
  const scope = `${date8}/${i.region}/${service}/aws4_request`;
  const expires = Math.min(Math.max(1, Math.floor(i.expiresSec ?? 3600)), 604_800);

  const params: Array<[string, string]> = [
    ...u.searchParams,
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${i.accessKey}/${scope}`],
    ['X-Amz-Date', date],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const query = canonicalQuery(params);
  const canonicalRequest = [i.method, u.pathname || '/', query, `host:${u.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(i.secretKey, date8, i.region, service)).update(stringToSign).digest('hex');
  return `${u.protocol}//${u.host}${u.pathname || '/'}?${query}&X-Amz-Signature=${signature}`;
}

// ───────────────────────────── bucket helpers ─────────────────────────────

/** Normalise a key prefix: no leading slash, trailing slash when non-empty. */
export function normPrefix(p: string | null | undefined): string {
  const s = (p ?? '').trim().replace(/^\/+/, '');
  return s && !s.endsWith('/') ? `${s}/` : s;
}

/** Path-style object (or bucket, when key is empty) URL. */
export function objectUrl(cfg: Pick<S3Config, 'endpoint' | 'bucket'>, key = ''): string {
  const base = cfg.endpoint.replace(/\/+$/, '');
  return `${base}/${rfc3986(cfg.bucket)}${key ? `/${encodeKey(key)}` : ''}`;
}

/** Object key for a backup file: <prefix><appName>/<file name>. */
export const backupKey = (cfg: Pick<S3Config, 'prefix'>, appName: string, fileName: string): string =>
  `${normPrefix(cfg.prefix)}${appName}/${fileName}`;

export function presignObject(cfg: S3Config, method: 'GET' | 'PUT', key: string, expiresSec = 3600, date?: Date): string {
  return presignUrl({ method, url: objectUrl(cfg, key), region: cfg.region || 'us-east-1', accessKey: cfg.accessKey, secretKey: cfg.secretKey, expiresSec, date });
}

async function send(cfg: S3Config, method: string, url: string, body: Buffer | null, f: FetchLike): Promise<Response> {
  const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
  const signed = signRequest({
    method, url, region: cfg.region || 'us-east-1', accessKey: cfg.accessKey, secretKey: cfg.secretKey, payloadHash, contentSha256Header: true,
  });
  return f(url, { method, headers: signed.headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(30_000) });
}

async function fail(op: string, res: Response): Promise<never> {
  const text = await res.text().catch(() => '');
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
  const msg = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
  throw new Error(`S3 ${op} failed: HTTP ${res.status}${code ? ` ${code}` : ''}${msg ? ` (${msg})` : ''}`);
}

export async function putObject(cfg: S3Config, key: string, body: string | Buffer, f: FetchLike = fetch): Promise<void> {
  const res = await send(cfg, 'PUT', objectUrl(cfg, key), Buffer.isBuffer(body) ? body : Buffer.from(body), f);
  if (!res.ok) await fail('PUT', res);
  await res.body?.cancel();
}

export async function deleteObject(cfg: S3Config, key: string, f: FetchLike = fetch): Promise<void> {
  const res = await send(cfg, 'DELETE', objectUrl(cfg, key), null, f);
  if (!res.ok && res.status !== 404) await fail('DELETE', res);
  await res.body?.cancel();
}

const xmlDecode = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');

export interface ListPage { keys: Array<{ key: string; size: number }>; nextToken: string | null }

/** Parse a ListObjectsV2 XML response. */
export function parseListXml(xml: string): ListPage {
  const keys: ListPage['keys'] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(m[1])?.[1];
    if (key != null) keys.push({ key: xmlDecode(key), size: Number(size ?? 0) });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { keys, nextToken: truncated && token ? xmlDecode(token) : null };
}

/** List every key under a prefix (ListObjectsV2, follows continuation tokens). */
export async function listObjects(cfg: S3Config, prefix: string, f: FetchLike = fetch): Promise<ListPage['keys']> {
  const all: ListPage['keys'] = [];
  let token: string | null = null;
  for (let page = 0; page < 100; page++) {
    const u = new URL(objectUrl(cfg));
    u.searchParams.set('list-type', '2');
    u.searchParams.set('prefix', prefix);
    if (token) u.searchParams.set('continuation-token', token);
    // Build the query ourselves so the URL we fetch is byte-identical to the one we signed.
    const url = `${u.origin}${u.pathname}?${canonicalQuery([...u.searchParams])}`;
    const res = await send(cfg, 'GET', url, null, f);
    if (!res.ok) await fail('LIST', res);
    const p = parseListXml(await res.text());
    all.push(...p.keys);
    if (!p.nextToken) break;
    token = p.nextToken;
  }
  return all;
}
