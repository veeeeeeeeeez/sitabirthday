const $ = (id) => document.getElementById(id)

const form = $('form')
const nameInput = $('name')
const messageInput = $('message')
const fileInput = $('video')
const filedrop = $('filedrop')
const preview = $('preview')
const previewThumb = $('previewThumb')
const previewFallback = $('previewFallback')
const submitBtn = $('submit')
const progress = $('progress')
const progressBar = $('progressBar')
const progressLabel = $('progressLabel')
const errorBox = $('error')

let posterBlob = null
let maxUploadMb = 200

/* ------------------------------------------------------------------ setup */

fetch('/api/config')
  .then((r) => r.json())
  .then(({ honoree, maxUploadMb: max }) => {
    maxUploadMb = max
    for (const el of document.querySelectorAll('[data-honoree]')) el.textContent = honoree
    for (const el of document.querySelectorAll('[data-max-mb]')) el.textContent = max
    document.title = `Wish ${honoree} a happy birthday`
  })
  .catch(() => {})

const formatSize = (bytes) => {
  const mb = bytes / (1024 * 1024)
  return mb < 1 ? `${Math.round(bytes / 1024)} KB` : `${mb.toFixed(1)} MB`
}

const showError = (msg) => {
  errorBox.textContent = msg
  errorBox.classList.add('is-visible')
  errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

const clearError = () => errorBox.classList.remove('is-visible')

/* ------------------------------------------------------- pick + preview */

// Grab a still from the video so the scrapbook shows a real frame instead of a
// black rectangle. Browsers vary wildly here (iOS especially), so every failure
// path just falls back to a plain card.
function extractPoster(file) {
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
      // A frame at 1s beats frame zero, which is often a dark fade-in.
      video.currentTime = Math.min(1, (video.duration || 2) / 2)
    })

    video.addEventListener('seeked', () => {
      clearTimeout(bail)
      try {
        const size = 480
        const canvas = document.createElement('canvas')
        const scale = Math.min(size / video.videoWidth, size / video.videoHeight, 1)
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        if (!canvas.width || !canvas.height) return done(null)
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((blob) => done(blob), 'image/jpeg', 0.8)
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

async function onFileChosen(file) {
  clearError()
  posterBlob = null
  previewThumb.hidden = true
  previewThumb.removeAttribute('src')
  previewFallback.hidden = false

  if (!file) {
    preview.classList.remove('is-visible')
    filedrop.classList.remove('has-file')
    return
  }

  if (file.size > maxUploadMb * 1024 * 1024) {
    showError(
      `That video is ${formatSize(file.size)}, over the ${maxUploadMb}MB limit. ` +
        `Try trimming it, or record a shorter one.`,
    )
    fileInput.value = ''
    preview.classList.remove('is-visible')
    filedrop.classList.remove('has-file')
    return
  }

  filedrop.classList.add('has-file')
  $('dropPrimary').textContent = 'Video selected — tap to change'
  $('previewName').textContent = file.name || 'Your video'
  $('previewSize').textContent = formatSize(file.size)
  preview.classList.add('is-visible')

  posterBlob = await extractPoster(file)
  if (posterBlob) {
    previewThumb.src = URL.createObjectURL(posterBlob)
    previewThumb.hidden = false
    previewFallback.hidden = true
  }
}

fileInput.addEventListener('change', () => onFileChosen(fileInput.files[0]))

// Drag and drop, for anyone on a laptop.
for (const evt of ['dragenter', 'dragover']) {
  filedrop.addEventListener(evt, (e) => {
    e.preventDefault()
    filedrop.classList.add('is-dragging')
  })
}
for (const evt of ['dragleave', 'drop']) {
  filedrop.addEventListener(evt, (e) => {
    e.preventDefault()
    filedrop.classList.remove('is-dragging')
  })
}
filedrop.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  if (!file.type.startsWith('video/')) return showError('That doesn’t look like a video file.')
  const dt = new DataTransfer()
  dt.items.add(file)
  fileInput.files = dt.files
  onFileChosen(file)
})

filedrop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    fileInput.click()
  }
})

/* ------------------------------------------------------------------ upload */

// XHR rather than fetch: it's the only way to get real upload progress, which
// matters a lot when someone is pushing 150MB over phone data.
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
        : reject(new Error(`Upload failed (${xhr.status})`)),
    )
    xhr.addEventListener('error', () => reject(new Error('Network error during upload')))
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')))
    xhr.send(blob)
  })
}

const setProgress = (fraction, label) => {
  progressBar.style.width = `${Math.round(fraction * 100)}%`
  if (label) progressLabel.textContent = label
}

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  clearError()

  const name = nameInput.value.trim()
  const file = fileInput.files[0]

  if (!name) {
    showError('Please add your name so she knows who it’s from.')
    return nameInput.focus()
  }
  if (!file) {
    showError('Please choose a video to send.')
    return
  }

  submitBtn.disabled = true
  submitBtn.textContent = 'Sending…'
  progress.classList.add('is-visible')
  setProgress(0, 'Getting ready…')

  try {
    const res = await fetch('/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: file.type, size: file.size }),
    })
    const slot = await res.json()
    if (!res.ok) throw new Error(slot.error || 'Could not start the upload.')

    await putWithProgress(slot.videoUrl, file, file.type, (f) =>
      setProgress(f * 0.94, `Uploading… ${Math.round(f * 100)}%`),
    )

    // Best effort: a missing poster only costs us a prettier card.
    let hasPoster = false
    if (posterBlob) {
      setProgress(0.96, 'Almost there…')
      try {
        await putWithProgress(slot.posterUrl, posterBlob, 'image/jpeg', () => {})
        hasPoster = true
      } catch {
        hasPoster = false
      }
    }

    setProgress(0.98, 'Saving your message…')
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

    setProgress(1, 'Sent!')
    sessionStorage.setItem('senderName', name)
    window.location.href = '/thanks'
  } catch (err) {
    showError(`${err.message} Your video wasn't sent — please try again.`)
    submitBtn.disabled = false
    submitBtn.textContent = 'Send it 🎉'
    progress.classList.remove('is-visible')
    setProgress(0)
  }
})
