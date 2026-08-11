const $ = (id) => document.getElementById(id)

const form = $('form')
const stageIdle = $('stageIdle')
const idleText = $('idleText')
const preview = $('preview')
const playback = $('playback')
const shutter = $('shutter')
const countdown = $('countdown')
const timer = $('timer')
const timerText = $('timerText')
const flip = $('flip')
const hint = $('hint')
const review = $('reviewActions')
const filepick = $('filepick')
const fileInput = $('video')
const nameInput = $('name')
const messageInput = $('message')
const submitBtn = $('submit')
const scrub = $('scrub')
const scrubFill = $('scrubFill')
const progress = $('progress')
const progressBar = $('progressBar')
const progressLabel = $('progressLabel')
const errorBox = $('error')

const MAX_SECONDS = 90
const POSTER_AT_MS = 1200

let stream = null
let recorder = null
let chunks = []
let videoBlob = null
let posterBlob = null
let facingMode = 'user'
let startedAt = 0
let tickHandle = null
let posterTimer = null
let rafHandle = 0
let maxUploadMb = 500

const RING = 2 * Math.PI * 48
countdown.style.strokeDasharray = String(RING)
countdown.style.strokeDashoffset = String(RING)

/* ------------------------------------------------------------------ config */

fetch('/api/config')
  .then((r) => r.json())
  .then(({ honoree, maxUploadMb: max }) => {
    maxUploadMb = max
    document.title = `A message for ${honoree}`
  })
  .catch(() => {})

/* ----------------------------------------------------------------- helpers */

const showError = (msg) => {
  errorBox.textContent = msg
  errorBox.classList.add('is-visible')
}

const clearError = () => errorBox.classList.remove('is-visible')

const formatTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

const formatSize = (bytes) => {
  const mb = bytes / (1024 * 1024)
  return mb < 1 ? `${Math.round(bytes / 1024)} KB` : `${mb.toFixed(1)} MB`
}

// Prefer MP4: Safari and iOS can be unreliable playing WebM, and she is most
// likely to watch the gallery on a phone.
function pickMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]
  for (const type of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(type)) return type
  }
  return ''
}

const canRecord = () =>
  Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && pickMimeType())

/* ------------------------------------------------------------------ camera */

function stopStream() {
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
}

async function startCamera() {
  clearError()
  hint.textContent = 'starting camera'
  shutter.disabled = true

  try {
    stopStream()
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    })

    preview.srcObject = stream
    preview.hidden = false
    // Mirrored only for the person looking at it; the recording is the raw
    // stream, so the file itself is never flipped.
    preview.classList.toggle('is-mirrored', facingMode === 'user')
    stageIdle.style.display = 'none'
    await preview.play().catch(() => {})

    shutter.disabled = false
    hint.textContent = ''

    // Only offer the flip control when there is actually a second camera.
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
    if (devices.filter((d) => d.kind === 'videoinput').length > 1) flip.classList.add('is-visible')
  } catch (err) {
    shutter.disabled = true
    stageIdle.style.display = ''
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
    idleText.textContent = denied
      ? 'Camera blocked. Allow it in your browser settings, or use the arrow to upload.'
      : 'No camera here. Use the arrow to upload a video.'
    hint.textContent = ''
  }
}

flip.addEventListener('click', () => {
  facingMode = facingMode === 'user' ? 'environment' : 'user'
  startCamera()
})

/* --------------------------------------------------------------- recording */

// A still off the live preview, used as the thumbnail on the wall.
function capturePoster() {
  if (posterBlob) return
  try {
    const w = preview.videoWidth
    const h = preview.videoHeight
    if (!w || !h) return
    const scale = Math.min(720 / w, 720 / h, 1)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    canvas.getContext('2d').drawImage(preview, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((b) => (posterBlob = b), 'image/jpeg', 0.85)
  } catch {
    /* a missing poster only costs a prettier card on the wall */
  }
}

function tick() {
  const elapsed = (Date.now() - startedAt) / 1000
  timerText.textContent = formatTime(elapsed)
  countdown.style.strokeDashoffset = String(RING * (1 - Math.min(elapsed / MAX_SECONDS, 1)))
  if (elapsed >= MAX_SECONDS) stopRecording()
}

function startRecording() {
  if (!stream) return
  clearError()
  chunks = []
  posterBlob = null

  const mimeType = pickMimeType()
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  } catch {
    return showError('This browser could not start recording. Try uploading a video instead.')
  }

  recorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size) chunks.push(e.data)
  })

  recorder.addEventListener('stop', () => {
    clearInterval(tickHandle)
    clearTimeout(posterTimer)
    capturePoster()

    videoBlob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' })
    if (!videoBlob.size) {
      resetToCamera()
      return showError('That recording came out empty. Please try again.')
    }
    if (videoBlob.size > maxUploadMb * 1024 * 1024) {
      resetToCamera()
      return showError(
        `That recording is ${formatSize(videoBlob.size)}, over the ${maxUploadMb}MB limit. Try a shorter one.`,
      )
    }
    enterReview(URL.createObjectURL(videoBlob))
  })

  recorder.start()
  startedAt = Date.now()
  shutter.dataset.state = 'recording'
  shutter.setAttribute('aria-label', 'Stop recording')
  timer.classList.add('is-visible')
  flip.classList.remove('is-visible')
  filepick.hidden = true
  hint.textContent = 'recording'
  timerText.textContent = '0:00'

  posterTimer = setTimeout(capturePoster, POSTER_AT_MS)
  tickHandle = setInterval(tick, 100)
}

function stopRecording() {
  clearInterval(tickHandle)
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  shutter.dataset.state = 'idle'
  shutter.setAttribute('aria-label', 'Record a video')
  timer.classList.remove('is-visible')
  countdown.style.strokeDashoffset = String(RING)
}

shutter.addEventListener('click', () => {
  if (shutter.dataset.state === 'recording') stopRecording()
  else if (stream) startRecording()
  else startCamera()
})

/* ---------------------------------------------------- custom playback bar */

function paintScrub() {
  const d = playback.duration
  if (Number.isFinite(d) && d > 0) {
    const pct = Math.min(100, (playback.currentTime / d) * 100)
    scrubFill.style.width = `${pct}%`
    scrub.setAttribute('aria-valuenow', String(Math.round(pct)))
  }
  rafHandle = requestAnimationFrame(paintScrub)
}

function seekFromEvent(e) {
  const r = scrub.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
  if (Number.isFinite(playback.duration)) playback.currentTime = ratio * playback.duration
}

let scrubbing = false
scrub.addEventListener('pointerdown', (e) => {
  scrubbing = true
  scrub.setPointerCapture(e.pointerId)
  seekFromEvent(e)
})
scrub.addEventListener('pointermove', (e) => {
  if (scrubbing) seekFromEvent(e)
})
scrub.addEventListener('pointerup', (e) => {
  scrubbing = false
  scrub.releasePointerCapture(e.pointerId)
})

/* ------------------------------------------------------------ review state */

function enterReview(url) {
  stopStream()
  preview.hidden = true
  stageIdle.style.display = 'none'
  shutter.hidden = true
  flip.classList.remove('is-visible')
  filepick.hidden = true
  hint.textContent = ''

  playback.src = url
  playback.hidden = false
  playback.loop = true
  // Stopping the take counts as user activation, so sound is usually allowed.
  // Fall back to muted rather than not playing at all.
  playback.muted = false
  playback.play().catch(() => {
    playback.muted = true
    playback.play().catch(() => {})
  })

  scrub.classList.add('is-visible')
  cancelAnimationFrame(rafHandle)
  rafHandle = requestAnimationFrame(paintScrub)

  review.classList.add('is-visible')
}

function resetToCamera() {
  videoBlob = null
  posterBlob = null

  cancelAnimationFrame(rafHandle)
  scrub.classList.remove('is-visible')
  scrubFill.style.width = '0%'

  playback.pause()
  playback.hidden = true
  playback.removeAttribute('src')
  playback.load()

  review.classList.remove('is-visible')
  shutter.hidden = false
  filepick.hidden = false
  fileInput.value = ''

  startCamera()
}

$('retake').addEventListener('click', () => {
  clearError()
  resetToCamera()
})

/* ------------------------------------------------- uploaded-file fallback */

// Seek-and-draw, used only for files the user picked.
function posterFromFile(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    const done = (result) => {
      URL.revokeObjectURL(url)
      video.remove()
      resolve(result)
    }
    const bail = setTimeout(() => done(null), 8000)

    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true
    video.src = url

    video.addEventListener('loadeddata', () => {
      video.currentTime = Math.min(1, (video.duration || 2) / 2)
    })
    video.addEventListener('seeked', () => {
      clearTimeout(bail)
      try {
        const scale = Math.min(720 / video.videoWidth, 720 / video.videoHeight, 1)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        if (!canvas.width || !canvas.height) return done(null)
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((b) => done(b), 'image/jpeg', 0.85)
      } catch {
        done(null)
      }
    })
    video.addEventListener('error', () => {
      clearTimeout(bail)
      done(null)
    })
  })
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0]
  if (!file) return
  clearError()

  if (file.size > maxUploadMb * 1024 * 1024) {
    fileInput.value = ''
    return showError(
      `That video is ${formatSize(file.size)}, over the ${maxUploadMb}MB limit. Try a shorter clip.`,
    )
  }

  videoBlob = file
  posterBlob = await posterFromFile(file)
  enterReview(URL.createObjectURL(file))
})

/* ------------------------------------------------------------------ upload */

// XHR, not fetch: it is the only way to get real upload progress, which matters
// when someone is pushing a large clip over phone data.
function putWithProgress(url, blob, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    })
    xhr.addEventListener('load', () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status}).`)),
    )
    xhr.addEventListener('error', () => reject(new Error('Network error during upload.')))
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled.')))
    xhr.send(blob)
  })
}

const setProgress = (fraction, label) => {
  progressBar.style.width = `${Math.round(fraction * 100)}%`
  progressLabel.textContent = label ?? ''
}

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  clearError()

  const name = nameInput.value.trim()
  if (!name) {
    showError('Please add your name so she knows who it’s from.')
    return nameInput.focus()
  }
  if (!videoBlob) return showError('Please record or choose a video first.')

  submitBtn.disabled = true
  $('retake').disabled = true
  progress.classList.add('is-visible')
  setProgress(0, '')

  try {
    const res = await fetch('/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: videoBlob.type, size: videoBlob.size }),
    })
    const slot = await res.json()
    if (!res.ok) throw new Error(slot.error || 'Could not start the upload.')

    // The PUT is signed over the server's normalized type, so echo it back.
    await putWithProgress(slot.videoUrl, videoBlob, slot.contentType, (f) =>
      setProgress(f * 0.94, `${Math.round(f * 100)}%`),
    )

    let hasPoster = false
    if (posterBlob) {
      setProgress(0.96, '')
      try {
        await putWithProgress(slot.posterUrl, posterBlob, 'image/jpeg', () => {})
        hasPoster = true
      } catch {
        hasPoster = false
      }
    }

    setProgress(0.98, '')
    const save = await fetch('/api/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: slot.id,
        videoKey: slot.videoKey,
        posterKey: slot.posterKey,
        hasPoster,
        name,
        message: messageInput.value.trim(),
      }),
    })
    if (!save.ok) throw new Error((await save.json()).error || 'Could not save your message.')

    setProgress(1, '')
    stopStream()
    sessionStorage.setItem('senderName', name)
    window.location.href = '/thanks'
  } catch (err) {
    showError(`${err.message} Your video was not sent — please try again.`)
    submitBtn.disabled = false
    $('retake').disabled = false
    progress.classList.remove('is-visible')
    setProgress(0, '')
  }
})

/* -------------------------------------------------------------------- init */

window.addEventListener('pagehide', stopStream)

if (!canRecord()) {
  shutter.hidden = true
  idleText.textContent = 'Recording is not supported here. Use the arrow to upload a video.'
}
