const $ = (id) => document.getElementById(id)

const board = $('board')
const status = $('status')
const lightbox = $('lightbox')
const lbVideo = $('lbVideo')
const lbName = $('lbName')
const lbMessage = $('lbMessage')
const lbIndex = $('lbIndex')
const lbPrev = $('lbPrev')
const lbNext = $('lbNext')

let submissions = []
let current = -1
let lastFocused = null

/* ------------------------------------------------------------------ cards */

// Deterministic per-id tilt: cards keep the same angle across reloads instead of
// jittering every time the page renders.
function tiltFor(id) {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return (Math.abs(hash) % 700) / 100 - 3.5 // -3.5deg .. +3.5deg
}

// Skip joining words so "Dev & Nisha" reads DN and "The Tuesday Run Club" reads TR.
const initialsOf = (name) =>
  name
    .split(/\s+/)
    .map((word) => word.match(/\p{L}/u)?.[0] ?? '')
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?'

function buildCard(item, index) {
  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'note'
  card.style.setProperty('--tilt', `${tiltFor(item.id)}deg`)
  card.style.animationDelay = `${Math.min(index * 55, 1200)}ms`
  card.setAttribute('aria-label', `Play the message from ${item.name}`)

  const photo = document.createElement('div')
  photo.className = 'note-photo'

  if (item.posterUrl) {
    const img = document.createElement('img')
    img.src = item.posterUrl
    img.alt = ''
    img.loading = 'lazy'
    // A poster that 404s (expired or never uploaded) falls back to initials.
    img.addEventListener('error', () => {
      img.remove()
      photo.prepend(makeInitials(item.name))
    })
    photo.append(img)
  } else {
    photo.append(makeInitials(item.name))
  }

  const play = document.createElement('div')
  play.className = 'note-play'
  play.innerHTML = '<span>&#9654;</span>'
  photo.append(play)

  const name = document.createElement('p')
  name.className = 'note-name'
  name.textContent = item.name

  card.append(photo, name)

  if (item.message) {
    const msg = document.createElement('p')
    msg.className = 'note-message'
    msg.textContent = item.message
    card.append(msg)
  }

  card.addEventListener('click', () => open(index))
  return card
}

function makeInitials(name) {
  const el = document.createElement('div')
  el.className = 'initials'
  el.textContent = initialsOf(name)
  return el
}

/* -------------------------------------------------------------- lightbox */

function open(index) {
  if (index < 0 || index >= submissions.length) return
  current = index
  const item = submissions[index]

  lastFocused = document.activeElement
  lbVideo.src = item.videoUrl
  lbName.textContent = item.name
  lbMessage.textContent = item.message || ''
  lbMessage.hidden = !item.message
  lbIndex.textContent = `${index + 1} of ${submissions.length}`
  lbPrev.disabled = index === 0
  lbNext.disabled = index === submissions.length - 1

  lightbox.hidden = false
  document.body.style.overflow = 'hidden'
  lbVideo.play().catch(() => {}) // autoplay may be blocked; controls still work
  lbVideo.focus()
}

function close() {
  lightbox.hidden = true
  lbVideo.pause()
  lbVideo.removeAttribute('src')
  lbVideo.load() // stop the download for a video she skipped past
  document.body.style.overflow = ''
  current = -1
  lastFocused?.focus()
}

const step = (delta) => open(current + delta)

$('lbClose').addEventListener('click', close)
lbPrev.addEventListener('click', () => step(-1))
lbNext.addEventListener('click', () => step(1))

// Click the backdrop (but not the video) to dismiss.
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) close()
})

// Roll straight into the next message, like a reel.
lbVideo.addEventListener('ended', () => {
  if (current < submissions.length - 1) step(1)
})

document.addEventListener('keydown', (e) => {
  if (lightbox.hidden) return
  if (e.key === 'Escape') close()
  else if (e.key === 'ArrowLeft') step(-1)
  else if (e.key === 'ArrowRight') step(1)
})

// Swipe between messages on a phone.
let touchStartX = null
lightbox.addEventListener('touchstart', (e) => (touchStartX = e.changedTouches[0].clientX), {
  passive: true,
})
lightbox.addEventListener(
  'touchend',
  (e) => {
    if (touchStartX === null) return
    const dx = e.changedTouches[0].clientX - touchStartX
    if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1)
    touchStartX = null
  },
  { passive: true },
)

/* -------------------------------------------------------------- confetti */

function confetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const colors = ['#c4553d', '#e9a08a', '#e8d6a8', '#8ba888', '#f0c05a']
  const layer = document.createElement('div')
  layer.className = 'confetti'
  layer.setAttribute('aria-hidden', 'true')

  for (let i = 0; i < 70; i++) {
    const bit = document.createElement('i')
    bit.style.left = `${Math.random() * 100}vw`
    bit.style.background = colors[i % colors.length]
    bit.style.animationDuration = `${2.6 + Math.random() * 2.4}s`
    bit.style.animationDelay = `${Math.random() * 1.6}s`
    layer.append(bit)
  }

  document.body.append(layer)
  setTimeout(() => layer.remove(), 7000)
}

/* ------------------------------------------------------------------ load */

try {
  const res = await fetch('/api/submissions')
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Could not load the scrapbook.')

  submissions = data.submissions
  for (const el of document.querySelectorAll('[data-honoree]')) el.textContent = data.honoree
  document.title = `${data.honoree}'s birthday scrapbook`

  status.remove()

  if (!submissions.length) {
    board.innerHTML =
      '<p class="board-status">The scrapbook is still empty — check back once friends have sent their messages.</p>'
  } else {
    const count = submissions.length
    $('count').textContent = `${count} ${count === 1 ? 'friend' : 'friends'}`
    const frag = document.createDocumentFragment()
    submissions.forEach((item, i) => frag.append(buildCard(item, i)))
    board.append(frag)
    confetti()
  }
} catch (err) {
  status.textContent = `${err.message} Try refreshing the page.`
}
