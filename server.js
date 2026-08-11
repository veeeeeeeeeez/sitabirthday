import express from 'express'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  HONOREE_NAME = 'Sita',
  VIEW_KEY = '',
  ADMIN_KEY = '',
  MAX_UPLOAD_MB = '200',
  PORT = 3000,
} = process.env

const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter(
  (k) => !process.env[k],
)
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`)
  console.error('Copy .env.example to .env and fill it in (see README.md).')
  process.exit(1)
}

// R2 rejects malformed credentials with a 403 that carries no CORS headers, so the
// browser reports it as a bare "network error" during upload. Say so up front
// instead. A common mix-up is pasting Cloudflare's "Token value" into both fields
// rather than the separate Access Key ID and Secret Access Key.
if (R2_ACCESS_KEY_ID.length !== 32 || R2_SECRET_ACCESS_KEY.length !== 64) {
  console.warn(
    `WARNING: R2 credentials look wrong (access key id is ${R2_ACCESS_KEY_ID.length} chars, ` +
      `expected 32; secret is ${R2_SECRET_ACCESS_KEY.length} chars, expected 64). ` +
      `Uploads will fail. Use the Access Key ID and Secret Access Key from the R2 API ` +
      `token screen, not the "Token value".`,
  )
}
if (R2_ACCESS_KEY_ID === R2_SECRET_ACCESS_KEY) {
  console.warn('WARNING: R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are identical.')
}

const maxUploadBytes = Number(MAX_UPLOAD_MB) * 1024 * 1024

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  // R2 documents its endpoint as path-style (<account>.r2.cloudflarestorage.com/<bucket>).
  // The SDK would otherwise default to a virtual-hosted bucket subdomain, which R2 can
  // 403 or misroute.
  forcePathStyle: true,
})

// Videos are big, so browsers upload straight to R2 with a presigned PUT and the
// server never touches the bytes. Each submission is one video, one poster frame,
// and one small JSON blob under meta/ -- no database to run or pay for.
const VIDEO_TYPES = new Map([
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
  ['video/webm', '.webm'],
  ['video/x-matroska', '.mkv'],
  ['video/mpeg', '.mpeg'],
  ['video/3gpp', '.3gp'],
])

const KNOWN_EXTENSIONS = [...new Set(VIDEO_TYPES.values())]

// MediaRecorder reports types like "video/webm;codecs=vp8,opus", so match on the
// bare type and drop the codec parameters.
const baseMimeType = (value) => String(value ?? '').split(';')[0].trim().toLowerCase()

const PLAYBACK_URL_TTL = 60 * 60 * 6 // 6h: long enough for one sitting on the wall
const UPLOAD_URL_TTL = 60 * 60 // 1h: generous for a slow phone upload

const app = express()
app.set('trust proxy', 1)
app.use(express.json({ limit: '64kb' }))

/* ------------------------------------------------------------------ helpers */

const clean = (value, maxLength) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : ''

const metaKey = (id) => `meta/${id}.json`

// Guests are friends with a private link, not the open internet. This just stops
// one broken script or bored person from filling the bucket.
const recentPresigns = new Map()
const PRESIGN_LIMIT = 12
const PRESIGN_WINDOW_MS = 10 * 60 * 1000

function rateLimited(ip) {
  const now = Date.now()
  const hits = (recentPresigns.get(ip) ?? []).filter((t) => now - t < PRESIGN_WINDOW_MS)
  hits.push(now)
  recentPresigns.set(ip, hits)
  if (recentPresigns.size > 5000) recentPresigns.clear()
  return hits.length > PRESIGN_LIMIT
}

// Listing the wall means one GET per submission, so hold the parsed metadata
// briefly. Playback URLs are signed fresh on every request (pure local crypto)
// so a cached entry can never hand out an expired link.
let metaCache = { at: 0, items: null }
const META_CACHE_MS = 30 * 1000

async function readAllMeta() {
  if (metaCache.items && Date.now() - metaCache.at < META_CACHE_MS) return metaCache.items

  const keys = []
  let ContinuationToken
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: 'meta/', ContinuationToken }),
    )
    for (const obj of page.Contents ?? []) if (obj.Key.endsWith('.json')) keys.push(obj.Key)
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (ContinuationToken)

  const settled = await Promise.allSettled(
    keys.map(async (Key) => {
      const res = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key }))
      return JSON.parse(await res.Body.transformToString())
    }),
  )

  const items = settled
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value)
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))

  const failed = settled.length - items.length
  if (failed) console.warn(`Skipped ${failed} unreadable submission(s)`)

  metaCache = { at: Date.now(), items }
  return items
}

/* --------------------------------------------------------------------- api */

app.get('/api/config', (_req, res) => {
  res.json({ honoree: HONOREE_NAME, maxUploadMb: Number(MAX_UPLOAD_MB) })
})

// Step 1 of an upload: hand the browser signed URLs to PUT the video (and its
// poster frame) directly into R2.
app.post('/api/uploads', async (req, res) => {
  try {
    if (rateLimited(req.ip)) {
      return res.status(429).json({ error: 'Too many uploads from here. Try again in a bit.' })
    }

    const { contentType, size } = req.body ?? {}
    const type = baseMimeType(contentType)
    const ext = VIDEO_TYPES.get(type)
    if (!ext) {
      return res.status(400).json({ error: "That file type isn't supported. Try an MP4 or MOV." })
    }
    if (!Number.isFinite(size) || size <= 0) {
      return res.status(400).json({ error: 'Invalid file size.' })
    }
    if (size > maxUploadBytes) {
      return res
        .status(413)
        .json({ error: `That video is over ${MAX_UPLOAD_MB}MB. Try a shorter clip.` })
    }

    const id = randomUUID()
    const videoKey = `videos/${id}${ext}`
    const posterKey = `posters/${id}.jpg`

    const [videoUrl, posterUrl] = await Promise.all([
      getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: R2_BUCKET, Key: videoKey, ContentType: type }),
        { expiresIn: UPLOAD_URL_TTL },
      ),
      getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: R2_BUCKET, Key: posterKey, ContentType: 'image/jpeg' }),
        { expiresIn: UPLOAD_URL_TTL },
      ),
    ])

    // Echo the normalized type back: the PUT is signed over it, so the browser has
    // to send this exact header rather than the raw MediaRecorder mime string.
    res.json({ id, videoKey, posterKey, videoUrl, posterUrl, contentType: type })
  } catch (err) {
    console.error('presign failed', err)
    res.status(500).json({ error: 'Could not start the upload. Please try again.' })
  }
})

// Step 2: the bytes are in R2, so record who it was from. A submission only
// counts once this lands, which keeps abandoned uploads off the wall.
app.post('/api/submissions', async (req, res) => {
  try {
    const { id, videoKey, posterKey, name, message, hasPoster, mirrored } = req.body ?? {}

    // Keys are echoed back from /api/uploads, so re-derive them rather than
    // trusting the client to point us at some other object in the bucket.
    const validVideoKeys = KNOWN_EXTENSIONS.map((ext) => `videos/${id}${ext}`)
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(id) ||
      !validVideoKeys.includes(videoKey) ||
      (hasPoster && posterKey !== `posters/${id}.jpg`)
    ) {
      return res.status(400).json({ error: 'Invalid submission.' })
    }

    const cleanName = clean(name, 60)
    if (!cleanName) return res.status(400).json({ error: 'Please add your name.' })

    const submission = {
      id,
      name: cleanName,
      message: clean(message, 500),
      videoKey,
      posterKey: hasPoster ? posterKey : null,
      // Front-camera takes are played back flipped, so what she sees matches
      // what the person saw while recording.
      mirrored: Boolean(mirrored),
      createdAt: new Date().toISOString(),
    }

    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: metaKey(id),
        ContentType: 'application/json',
        Body: JSON.stringify(submission),
      }),
    )

    metaCache = { at: 0, items: null }
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('submission failed', err)
    res.status(500).json({ error: 'Could not save your message. Please try again.' })
  }
})

// Frames for the strip on the recording page. Deliberately poster images only:
// the friend recording should see the roll continue above and below them
// without being handed everyone else's names and notes.
app.get('/api/reel', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 24)
    const items = (await readAllMeta()).filter((i) => i.posterKey).slice(-limit)
    const frames = await Promise.all(
      items.map((item) =>
        getSignedUrl(s3, new GetObjectCommand({ Bucket: R2_BUCKET, Key: item.posterKey }), {
          expiresIn: PLAYBACK_URL_TTL,
        }),
      ),
    )
    res.json({ frames })
  } catch (err) {
    console.error('reel failed', err)
    res.json({ frames: [] }) // decorative only, so never fail the page over it
  }
})

app.get('/api/submissions', async (_req, res) => {
  try {
    const items = await readAllMeta()
    const withUrls = await Promise.all(
      items.map(async (item) => ({
        id: item.id,
        name: item.name,
        message: item.message,
        mirrored: Boolean(item.mirrored),
        createdAt: item.createdAt,
        videoUrl: await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: R2_BUCKET, Key: item.videoKey }),
          { expiresIn: PLAYBACK_URL_TTL },
        ),
        posterUrl: item.posterKey
          ? await getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: R2_BUCKET, Key: item.posterKey }),
              { expiresIn: PLAYBACK_URL_TTL },
            )
          : null,
      })),
    )
    res.json({ honoree: HONOREE_NAME, submissions: withUrls })
  } catch (err) {
    console.error('list failed', err)
    res.status(500).json({ error: 'Could not load the scrapbook.' })
  }
})

// Escape hatch for a duplicate or a video that came out wrong.
app.delete('/api/submissions/:id', async (req, res) => {
  if (!ADMIN_KEY || req.get('x-admin-key') !== ADMIN_KEY) return res.sendStatus(403)
  try {
    const item = (await readAllMeta()).find((s) => s.id === req.params.id)
    if (!item) return res.sendStatus(404)

    const keys = [metaKey(item.id), item.videoKey, item.posterKey].filter(Boolean)
    await Promise.all(
      keys.map((Key) => s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key }))),
    )

    metaCache = { at: 0, items: null }
    res.json({ ok: true, deleted: keys })
  } catch (err) {
    console.error('delete failed', err)
    res.status(500).json({ error: 'Delete failed.' })
  }
})

app.get('/healthz', (_req, res) => res.type('text').send('ok'))

/* ------------------------------------------------------------------- pages */

app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }))

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))
app.get('/thanks', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'thanks.html')))

// The wall sits behind an unguessable path so a forwarded link can't spoil it.
const wallPath = VIEW_KEY ? `/wall/${VIEW_KEY}` : '/wall'
app.get(wallPath, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'wall.html')))
app.get('/wall*', (_req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')))

app.use((_req, res) => res.redirect('/'))

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Birthday scrapbook for ${HONOREE_NAME} running on port ${PORT}`)
  console.log(`  upload page : /`)
  console.log(`  the wall    : ${wallPath}`)
  if (!VIEW_KEY) console.log('  (VIEW_KEY is unset, so the wall is public)')
})
