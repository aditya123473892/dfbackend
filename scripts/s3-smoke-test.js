/* Local-only S3 diagnostic. No database, app auth, bucket checks or moderation. */
const http = require('node:http');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { S3, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const sharp = require('sharp');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const port = Number(process.env.S3_TEST_PORT || 9011);
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString('hex');
const maxBytes = 5 * 1024 * 1024;
const bucket = process.env.AWS_DEFAULT_S3_BUCKET;
const region = process.env.AWS_S3_REGION || process.env.AWS_REGION;
if (!bucket || !region)
  throw new Error('Backend S3 bucket and region are required');
const accessKeyId = process.env.AWS_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey =
  process.env.AWS_SECRET || process.env.AWS_SECRET_ACCESS_KEY;
const s3 = new S3({
  region,
  ...(accessKeyId
    ? {
        credentials: {
          accessKeyId,
          secretAccessKey,
          sessionToken: process.env.AWS_SESSION_TOKEN,
        },
      }
    : {}),
  requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 },
  maxAttempts: 1,
});
const images = new Map();
let uploading = false;
function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}
async function upload(bytes) {
  const clean = await sharp(bytes, {
    limitInputPixels: 40000000,
    failOn: 'warning',
  })
    .rotate()
    .resize({
      width: 1080,
      height: 1080,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80 })
    .toBuffer();
  const id = randomUUID();
  const key = `temp/diagnostics/${id}.jpg`;
  const put = await s3
    .putObject({
      Bucket: bucket,
      Key: key,
      Body: clean,
      ContentType: 'image/jpeg',
      ServerSideEncryption: 'AES256',
    });
  const image = { id, key, bytes: clean.length, versionId: put.VersionId };
  images.set(id, image);
  return image;
}
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>S3 upload test</title><style>body{font:16px system-ui;background:#111827;color:#e5e7eb;max-width:760px;margin:50px auto;padding:20px}section{background:#1f2937;padding:24px;border-radius:16px;margin:20px 0}h1{margin:0}button,a{font:inherit;cursor:pointer;background:#a7f3d0;color:#111827;border:0;border-radius:8px;padding:10px 16px;display:inline-block;margin:8px 8px 8px 0;text-decoration:none}button:disabled{opacity:.5;cursor:wait}input{display:block;margin:18px 0}img{max-width:100%;max-height:400px;display:block;border-radius:8px}#status{white-space:pre-wrap}small{color:#9ca3af}code{overflow-wrap:anywhere}</style>
<h1>S3 upload → preview → download</h1><p>This standalone test uses your backend's S3 credentials. No app login, database or moderation.</p>
<section><label>Choose an image (maximum 5 MB)<input id="file" type="file" accept="image/jpeg,image/png,image/webp"></label><button id="upload">Upload to S3</button><p id="status" role="status">Loading test images…</p><small>Flow: browser → local diagnostic server → S3. This tests S3 Put/Get, separately from the Expo direct-upload flow.</small></section>
<section id="result" hidden><h2>Image stored in S3</h2><p><code id="key"></code></p><img id="preview" alt="Image read back from S3"><p id="read"></p><a id="download">Download from S3</a><button id="direct">Get direct S3 link</button><p><a id="s3link" hidden target="_blank" rel="noreferrer">Open private S3 image (link expires in 2 minutes)</a></p></section>
<small>Local testing only. Images are re-encoded as JPEG and stored under temp/diagnostics/. Use Delete test image after testing.</small><p><button id="delete" hidden>Delete test image</button></p>
<script>
const token=${JSON.stringify(token)};
const $=id=>document.getElementById(id);let current,preview;
async function request(url,options={}){const r=await fetch(url,{...options,headers:{...options.headers,'X-S3-Test-Token':token}});if(!r.ok){const e=await r.json();throw Error(e.error||'Request failed');}return r;}
async function show(image){current=image;$('result').hidden=false;$('key').textContent=image.key;$('read').textContent='Reading image back from S3…';const r=await request('/api/images/'+image.id);const blob=await r.blob();if(preview)URL.revokeObjectURL(preview);preview=URL.createObjectURL(blob);$('preview').src=preview;$('download').href=preview;$('download').download='s3-test.jpg';$('read').textContent='S3 GetObject succeeded: '+blob.size+' bytes.';$('s3link').hidden=true;$('delete').hidden=false;}
$('upload').onclick=async()=>{const file=$('file').files[0];if(!file){$('status').textContent='Choose an image first.';return;}if(file.size>5242880){$('status').textContent='Image must be 5 MB or smaller.';return;}$('upload').disabled=true;try{$('status').textContent='Uploading to S3…';const r=await request('/api/images',{method:'POST',headers:{'Content-Type':file.type},body:file});const image=await r.json();$('status').textContent='S3 PutObject succeeded. Reading it back…';await show(image);$('status').textContent='Upload and retrieval both succeeded.';}catch(e){$('status').textContent=e.message;}finally{$('upload').disabled=false;}};
$('direct').onclick=async()=>{try{const r=await request('/api/images/'+current.id+'/url');$('s3link').href=(await r.json()).url;$('s3link').hidden=false;}catch(e){$('status').textContent=e.message;}};
$('delete').onclick=async()=>{try{await request('/api/images/'+current.id,{method:'DELETE'});$('result').hidden=true;$('delete').hidden=true;$('status').textContent='Test image deleted from S3.';}catch(e){$('status').textContent=e.message;}};
request('/api/images').then(r=>r.json()).then(async images=>{if(images.length){await show(images[images.length-1]);$('status').textContent='Sample image uploaded and retrieved from S3. You can download it below.';}else $('status').textContent='Choose an image to test.';}).catch(e=>$('status').textContent=e.message);
</script></html>`;

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob:; frame-ancestors 'none'",
  );
  if (
    req.headers.host !== `127.0.0.1:${port}` ||
    (req.headers.origin && req.headers.origin !== origin)
  )
    return json(res, 403, { error: 'Local access only' });
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  if (req.headers['x-s3-test-token'] !== token)
    return json(res, 403, { error: 'Open the local test page first' });
  try {
    if (req.url === '/api/images' && req.method === 'GET')
      return json(res, 200, [...images.values()]);
    if (req.url === '/api/images' && req.method === 'POST') {
      if (uploading || images.size >= 5)
        return json(res, 429, {
          error:
            'One upload at a time; delete test images after testing (maximum five).',
        });
      if (
        !['image/jpeg', 'image/png', 'image/webp'].includes(
          req.headers['content-type'],
        )
      )
        return json(res, 400, { error: 'Choose JPEG, PNG or WebP' });
      uploading = true;
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > maxBytes) {
            json(res, 413, { error: 'Maximum image size is 5 MB' });
            return;
          }
          chunks.push(chunk);
        }
        return json(res, 201, await upload(Buffer.concat(chunks)));
      } finally {
        uploading = false;
      }
    }
    const match = /^\/api\/images\/([a-f0-9-]+)(\/url)?$/.exec(req.url);
    const image = match && images.get(match[1]);
    if (!image)
      return json(res, 404, {
        error: 'Test image not found in this diagnostic session',
      });
    if (req.method === 'GET' && match[2])
      return json(res, 200, {
        url: await getSignedUrl(s3, new GetObjectCommand({
          Bucket: bucket,
          Key: image.key,
        }), { expiresIn: 120 }),
      });
    if (req.method === 'GET') {
      const value = await s3
        .getObject({ Bucket: bucket, Key: image.key });
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return res.end(Buffer.from(await value.Body.transformToByteArray()));
    }
    if (req.method === 'DELETE') {
      await s3
        .deleteObject({
          Bucket: bucket,
          Key: image.key,
          ...(image.versionId ? { VersionId: image.versionId } : {}),
        });
      images.delete(image.id);
      return json(res, 200, { deleted: true });
    }
    json(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    const code =
      typeof error.code === 'string' && /^[A-Za-z0-9]+$/.test(error.code)
        ? error.code
        : 'ImageProcessingFailed';
    json(res, 502, {
      error: `S3 diagnostic failed: ${code}. No credentials are shown.`,
    });
  }
});
async function main() {
  if (process.argv.includes('--sample')) {
    const sample = await sharp({
      create: { width: 640, height: 400, channels: 3, background: '#36a88d' },
    })
      .jpeg()
      .toBuffer();
    const image = await upload(sample);
    const result = await s3
      .getObject({ Bucket: bucket, Key: image.key });
    console.log(
      `Sample S3 PutObject/GetObject succeeded (${(await result.Body.transformToByteArray()).length} bytes).`,
    );
  }
  server.listen(port, '127.0.0.1', () =>
    console.log(`S3 test page: ${origin}`),
  );
}
main().catch((error) => {
  console.error(`S3 test could not start: ${error.code || error.name}`);
  process.exitCode = 1;
});
