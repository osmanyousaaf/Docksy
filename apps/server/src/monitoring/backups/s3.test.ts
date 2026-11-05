import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from './s3.ts';
import { isDue, selectPrune, selectS3Prune, SCHEDULE_MS } from './policy.ts';

test('SigV4 matches the AWS test suite vector (get-vanilla)', () => {
  const s = S.signRequest({
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    region: 'us-east-1',
    service: 'service',
    accessKey: 'AKIDEXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    date: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(s.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(
    s.headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
  assert.equal(s.headers['x-amz-date'], '20150830T123600Z');
});

test('presigned URL matches the AWS S3 documentation example', () => {
  const url = S.presignUrl({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    region: 'us-east-1',
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    expiresSec: 86400,
    date: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(
    url,
    'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
  );
});

test('presignObject: path-style PUT URL format', () => {
  const cfg: S.S3Config = { endpoint: 'http://minio:9000/', bucket: 'backups', region: 'auto', accessKey: 'AK', secretKey: 'SK', prefix: 'docksy/' };
  const key = S.backupKey(cfg, 'db', '20261101T120000Z.gz');
  assert.equal(key, 'docksy/db/20261101T120000Z.gz');
  const u = new URL(S.presignObject(cfg, 'PUT', key, 3600, new Date('2026-11-01T12:00:00Z')));
  assert.equal(u.origin + u.pathname, 'http://minio:9000/backups/docksy/db/20261101T120000Z.gz');
  assert.equal(u.searchParams.get('X-Amz-Credential'), 'AK/20261101/auto/s3/aws4_request');
  assert.equal(u.searchParams.get('X-Amz-Expires'), '3600');
  assert.equal(u.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.match(u.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);
  assert.ok(!u.toString().includes('SK'), 'secret never appears in the URL');
});

test('encoding helpers', () => {
  assert.equal(S.rfc3986("a b!'()*"), 'a%20b%21%27%28%29%2A');
  assert.equal(S.encodeKey('a b/c+d.gz'), 'a%20b/c%2Bd.gz');
  assert.equal(S.normPrefix('/foo'), 'foo/');
  assert.equal(S.normPrefix(''), '');
  assert.equal(S.canonicalQuery([['b', '2'], ['a', 'x y'], ['a', '1']]), 'a=1&a=x%20y&b=2');
});

test('parseListXml + listObjects follows continuation and signs requests', async () => {
  const page1 = '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;2</NextContinuationToken><Contents><Key>p/db/a&amp;b.gz</Key><Size>10</Size></Contents></ListBucketResult>';
  const page2 = '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>p/db/c.gz</Key><Size>5</Size></Contents></ListBucketResult>';
  assert.deepEqual(S.parseListXml(page1), { keys: [{ key: 'p/db/a&b.gz', size: 10 }], nextToken: 't&2' });
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const fake = async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(seen.length === 1 ? page1 : page2, { status: 200 });
  };
  const cfg: S.S3Config = { endpoint: 'https://s3.example.com', bucket: 'b', region: 'us-east-1', accessKey: 'AK', secretKey: 'SK', prefix: 'p/' };
  const keys = await S.listObjects(cfg, 'p/db/', fake);
  assert.deepEqual(keys.map((k) => k.key), ['p/db/a&b.gz', 'p/db/c.gz']);
  assert.equal(seen.length, 2);
  assert.ok(seen[1].url.includes('continuation-token=t%262'));
  const h = seen[0].init?.headers as Record<string, string>;
  assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
});

test('deleteObject tolerates 404 and surfaces S3 errors', async () => {
  const cfg: S.S3Config = { endpoint: 'https://s3.example.com', bucket: 'b', region: 'us-east-1', accessKey: 'AK', secretKey: 'SK', prefix: '' };
  await S.deleteObject(cfg, 'k', async () => new Response(null, { status: 404 }));
  await assert.rejects(
    S.deleteObject(cfg, 'k', async () => new Response('<Error><Code>AccessDenied</Code><Message>nope</Message></Error>', { status: 403 })),
    /HTTP 403 AccessDenied \(nope\)/,
  );
});

test('schedule due-logic', () => {
  const t = Date.UTC(2026, 10, 1, 12);
  assert.equal(isDue('daily', null, t), true);
  assert.equal(isDue('hourly', t - SCHEDULE_MS.hourly + 10_000, t), true); // within tick slack
  assert.equal(isDue('hourly', t - 30 * 60_000, t), false);
  assert.equal(isDue('daily', t - 23 * 3600_000, t), false);
  assert.equal(isDue('daily', t - 24 * 3600_000, t), true);
  assert.equal(isDue('weekly', t - 6 * 86_400_000, t), false);
  assert.equal(isDue('weekly', t - 7 * 86_400_000, t), true);
});

test('retention selection (local runs)', () => {
  const runs = [1, 5, 3, 4, 2].map((n) => ({ id: `r${n}`, path: `/p/${n}.gz`, startedAt: n }));
  assert.deepEqual(selectPrune(runs, 3).map((r) => r.id), ['r2', 'r1']);
  assert.deepEqual(selectPrune(runs, 10), []);
  assert.deepEqual(selectPrune(runs, 0).map((r) => r.id), ['r4', 'r3', 'r2', 'r1']); // always keep at least one
});

test('retention selection (S3 keys) only touches Docksy backup files', () => {
  const keys = [
    'docksy/db/20261101T100000Z.gz',
    'docksy/db/20261101T120000Z.gz',
    'docksy/db/notes.txt',
    'docksy/db/20261101T110000Z.gz',
    'docksy/db/20261031T120000Z.gz',
  ];
  assert.deepEqual(selectS3Prune(keys, 2), ['docksy/db/20261101T100000Z.gz', 'docksy/db/20261031T120000Z.gz']);
});
