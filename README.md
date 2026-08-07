# Sita's birthday scrapbook

Friends upload a short video wishing her happy birthday. She gets a scrapbook wall
of taped-down cards to tap through on the day.

- **`/`** — the page you send to friends. Name, optional note, one video. No login.
- **`/wall/<VIEW_KEY>`** — the page you send to her. Cards, tap to play, arrow/swipe
  between messages, autoplays into the next one.

Videos go **straight from the friend's browser into Cloudflare R2** via a presigned
URL, so the server never handles the bytes and nothing is lost on redeploy. There's
no database — each submission is a video, a poster frame, and a small JSON file in
the bucket.

---

## Setup

### 1. Cloudflare R2 (where the videos live)

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) → **R2**. The free
   tier is 10GB with no egress fees; 100 friends at ~50MB each is ~5GB.
2. **Create bucket** — this project uses one named `videos`.
3. **R2 → API → Manage API Tokens → Create API Token**
   - Permission: **Object Read & Write**
   - Scope it to that bucket
   - Save the **Access Key ID** and **Secret Access Key** — the secret is shown once.
4. Grab your **Account ID** — it's the subdomain of the S3 API endpoint shown on the
   bucket's settings page (`https://<account-id>.r2.cloudflarestorage.com/videos`).

### 2. CORS on the bucket — don't skip this

Browsers upload directly to R2, so the bucket must allow it. Cloudflare prefills
this box with a `GET`-only example; leave that in place and **every upload fails**
with an opaque CORS error. Uploads are `PUT` and carry a `Content-Type` header, so
both need to be allowed.

**R2 → your bucket → Settings → CORS Policy → Edit**, and replace the whole thing:

```json
[
  {
    "AllowedOrigins": [
      "https://sitabirthday.com",
      "https://www.sitabirthday.com",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Origins must match exactly — scheme included, no trailing slash, no path. List every
hostname friends might actually load the site on. If uploads still fail with a CORS
error, widen `AllowedHeaders` to `["*"]` to rule it out.

### 3. Deploy to Render

**New → Web Service**, point it at this repo, then:

| Field | Value |
| --- | --- |
| Runtime | Node |
| Build Command | `npm ci` |
| **Start Command** | **`npm start`** |
| Health Check Path | `/healthz` |

Then **Environment → Add Environment Variable** for each:

| Key | Value |
| --- | --- |
| `R2_ACCOUNT_ID` | from step 1 |
| `R2_ACCESS_KEY_ID` | from step 1 |
| `R2_SECRET_ACCESS_KEY` | from step 1 |
| `R2_BUCKET` | `videos` |
| `HONOREE_NAME` | `Sita` |
| `VIEW_KEY` | any random word, e.g. `ramen-kyoto-2am` |
| `ADMIN_KEY` | a long random string |
| `MAX_UPLOAD_MB` | `200` |

Render sets `PORT` itself — don't add it.

> The repo also has a `render.yaml`, so you can use **New → Blueprint** instead and
> it fills in everything but the secrets.

### 4. Point sitabirthday.com at Render

In Render: **Settings → Custom Domains → Add** both `sitabirthday.com` and
`www.sitabirthday.com`. Then in Cloudflare **DNS**:

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| CNAME | `@` | `sitabirthday.onrender.com` | **DNS only (grey)** |
| CNAME | `www` | `sitabirthday.onrender.com` | **DNS only (grey)** |

Cloudflare flattens the apex CNAME automatically, so no A record is needed.

If Cloudflare says *"An A, AAAA, or CNAME record with that host already exists"*, it
pre-created a placeholder when the domain was registered. Edit that existing root
record in place (change its type to CNAME and retarget it) or delete it first — DNS
forbids a CNAME alongside an A/AAAA on the same name. Leave `MX` and `TXT` records
alone; only A/AAAA/CNAME conflict, and removing MX would break email on the domain.

Three things that will waste an afternoon if you miss them:

1. **Start on grey cloud.** Proxying (orange) intercepts Render's domain validation and
   the TLS certificate never issues. Wait until Render shows the domain as verified.
2. **Delete any `AAAA` records.** Render has no IPv6, so an `AAAA` record breaks routing
   and blocks certificate issuance.
3. **If you later switch to orange cloud, set SSL/TLS mode to Full (Strict).** The
   default *Flexible* mode causes an infinite redirect loop against Render.

Staying on grey cloud the whole time is completely fine here, and is the fewest moving
parts.

### 5. Share the links

- Friends → `https://sitabirthday.com`
- Her → `https://sitabirthday.com/wall/ramen-kyoto-2am`

The wall lives behind `VIEW_KEY` so a forwarded link can't spoil the surprise. Any
other `/wall/...` path 404s. Leave `VIEW_KEY` blank to make `/wall` fully open.

---

## Running locally

```bash
npm install
cp .env.example .env    # fill in your R2 values
node --env-file=.env server.js
```

Then http://localhost:3000 and http://localhost:3000/wall/surprise.

## Removing a bad submission

Deletes the video, poster, and metadata:

```bash
curl -X DELETE https://sitabirthday.onrender.com/api/submissions/<id> \
  -H "x-admin-key: $ADMIN_KEY"
```

Get the `<id>` from `/api/submissions`.

## Notes

- **Render's free tier sleeps** after 15 min idle, so the first visit takes ~30s to
  wake. For the actual birthday, bump to the $7/mo Starter plan so her first click
  is instant.
- **Cloudflare's proxy caps request bodies at 100MB** on free plans, but that never
  applies here: videos go from the friend's browser straight to R2 and never pass
  through `sitabirthday.com`. Only small JSON requests hit the Render service. If
  uploads were proxied through the server instead, anything over 100MB would fail.
- Uploads are capped at `MAX_UPLOAD_MB` (200 by default) and rate-limited to 12 per
  IP per 10 minutes.
- A poster frame is grabbed in the browser via canvas. If that fails (some iOS
  versions), the card falls back to the friend's initials on a colored tile — the
  video itself is unaffected.
- Playback URLs are presigned and expire after 6 hours; the wall re-signs them on
  every page load, so the bucket never has to be public.
