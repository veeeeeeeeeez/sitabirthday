const $ = (id) => document.getElementById(id)

const gallery = $('gallery')
const status = $('status')
const lightbox = $('lightbox')
const lbVideo = $('lbVideo')
const lbName = $('lbName')
const lbMessage = $('lbMessage')
const lbNote = $('lbNote')
const lbIndex = $('lbIndex')
const lbPrev = $('lbPrev')
const lbNext = $('lbNext')
const scrollLeft = $('scrollLeft')
const scrollRight = $('scrollRight')

let submissions = []
let current = -1
let lastFocused = null

const pad = (n) => String(n).padStart(2, '0')

const monogramOf = (name) => name.match(/\p{L}/u)?.[0]?.toUpperCase() ?? '?'

// Deterministic per-id tilt, so the wall looks hand-placed but never reshuffles
// between reloads.
function tiltFor(id) {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return ((Math.abs(hash) % 500) / 100 - 2.5).toFixed(2) // -2.5deg .. +2.5deg
}

function makeMonogram(name) {
  const el = document.createElement('div')
  el.className = 'monogram'
  el.textContent = monogramOf(name)
  return el
}

function buildWork(item, index) {
  const work = document.createElement('button')
  work.type = 'button'
  work.className = 'work'
  // Every fourth work runs the full height, which stops the two rows reading
  // as a plain filmstrip.
  if (index % 4 === 1) work.classList.add('work--tall')
  work.style.animationDelay = `${Math.min(index * 45, 900)}ms`
  work.setAttribute('aria-label', `Play the message from ${item.name}`)

  const plate = document.createElement('div')
  plate.className = 'work-plate'
  plate.style.setProperty('--tilt', `${tiltFor(item.id)}deg`)

  if (item.posterUrl) {
    const img = document.createElement('img')
    img.src = item.posterUrl
    img.alt = ''
    img.loading = 'lazy'
    img.addEventListener('error', () => {
      img.remove()
      plate.prepend(makeMonogram(item.name))
    })
    plate.append(img)
  } else {
    plate.append(makeMonogram(item.name))
  }

  const play = document.createElement('div')
  play.className = 'play'
  play.innerHTML = '<span>&#9654;</span>'
  plate.append(play)

  const label = document.createElement('div')
  label.className = 'work-label'

  const idx = document.createElement('span')
  idx.className = 'work-index'
  idx.textContent = pad(index + 1)

  const text = document.createElement('div')
  text.className = 'work-text'

  const name = document.createElement('p')
  name.className = 'work-name'
  name.textContent = item.name
  text.append(name)

  if (item.noteUrl) {
    const drawn = document.createElement('img')
    drawn.className = 'work-note-drawn'
    drawn.src = item.noteUrl
    drawn.alt = 'A drawn note'
    drawn.loading = 'lazy'
    text.append(drawn)
  } else if (item.message) {
    const note = document.createElement('p')
    note.className = 'work-note'
    note.textContent = item.message
    text.append(note)
  }

  label.append(idx, text)
  work.append(plate, label)
  work.addEventListener('click', () => open(index))
  return work
}

/* -------------------------------------------------------------- scrolling */

function updateArrows() {
  const max = gallery.scrollWidth - gallery.clientWidth
  scrollLeft.disabled = gallery.scrollLeft <= 2
  scrollRight.disabled = gallery.scrollLeft >= max - 2
}

const nudge = (dir) =>
  gallery.scrollBy({ left: dir * Math.round(gallery.clientWidth * 0.8), behavior: 'smooth' })

scrollLeft.addEventListener('click', () => nudge(-1))
scrollRight.addEventListener('click', () => nudge(1))
gallery.addEventListener('scroll', updateArrows, { passive: true })
window.addEventListener('resize', updateArrows)

// A vertical wheel over the gallery should push it sideways — otherwise a
// trackpad just scrolls the page past it.
gallery.addEventListener(
  'wheel',
  (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    const max = gallery.scrollWidth - gallery.clientWidth
    const atStart = gallery.scrollLeft <= 0 && e.deltaY < 0
    const atEnd = gallery.scrollLeft >= max && e.deltaY > 0
    if (atStart || atEnd) return // let the page take over at the ends
    e.preventDefault()
    gallery.scrollLeft += e.deltaY
  },
  { passive: false },
)

/* -------------------------------------------------------------- lightbox */

function open(index) {
  if (index < 0 || index >= submissions.length) return
  current = index
  const item = submissions[index]

  if (lightbox.hidden) lastFocused = document.activeElement
  lbVideo.src = item.videoUrl
  lbVideo.classList.toggle('is-mirrored', Boolean(item.mirrored))
  lbName.textContent = `${pad(index + 1)} — ${item.name}`
  // A note is either typed or drawn, never both.
  lbMessage.textContent = item.message || ''
  lbMessage.hidden = !item.message
  lbNote.src = item.noteUrl || ''
  lbNote.hidden = !item.noteUrl
  lbIndex.textContent = `${pad(index + 1)} of ${pad(submissions.length)}`
  lbPrev.disabled = index === 0
  lbNext.disabled = index === submissions.length - 1

  lightbox.hidden = false
  document.body.style.overflow = 'hidden'
  lbVideo.play().catch(() => {}) // autoplay may be blocked; controls still work
  lbVideo.focus({ preventScroll: true })
}

function close() {
  lightbox.hidden = true
  lbVideo.pause()
  lbVideo.removeAttribute('src')
  lbVideo.load() // stop downloading a film she skipped past
  document.body.style.overflow = ''
  current = -1
  lastFocused?.focus()
}

const step = (delta) => open(current + delta)

$('lbClose').addEventListener('click', close)
lbPrev.addEventListener('click', () => step(-1))
lbNext.addEventListener('click', () => step(1))

lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) close()
})

lbVideo.addEventListener('ended', () => {
  if (current < submissions.length - 1) step(1)
})

document.addEventListener('keydown', (e) => {
  if (lightbox.hidden) return
  if (e.key === 'Escape') close()
  else if (e.key === 'ArrowLeft') step(-1)
  else if (e.key === 'ArrowRight') step(1)
})

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

/* ------------------------------------------------------------------ load */

try {
  const res = await fetch('/api/submissions')
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Could not load the exhibition.')

  submissions = data.submissions
  for (const el of document.querySelectorAll('[data-honoree]')) el.textContent = data.honoree
  document.title = `${data.honoree} — a private exhibition`

  status.remove()

  if (!submissions.length) {
    gallery.innerHTML =
      '<p class="board-status">The walls are still bare. Check back once the first films arrive.</p>'
  } else {
    gallery.classList.remove('is-empty')
    const n = submissions.length
    $('countLabel').textContent = `${pad(n)} ${n === 1 ? 'work' : 'works'}`
    $('cueText').textContent = '( scroll sideways )'

    const frag = document.createDocumentFragment()
    submissions.forEach((item, i) => frag.append(buildWork(item, i)))
    gallery.append(frag)
    requestAnimationFrame(updateArrows)
  }
} catch (err) {
  status.textContent = `${err.message} Try refreshing the page.`
}
