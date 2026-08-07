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

/* ------------------------------------------------------------------ works */

// Skip joining words so "Dev & Nisha" reads D and "The Tuesday Run Club" reads T.
const monogramOf = (name) => name.match(/\p{L}/u)?.[0]?.toUpperCase() ?? '?'

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']
const numeral = (n) => {
  if (n <= 10) return ROMAN[n - 1]
  const tens = Math.floor(n / 10)
  return (tens === 1 ? 'X' : tens === 2 ? 'XX' : tens === 3 ? 'XXX' : `${tens}0`) +
    (n % 10 ? ROMAN[(n % 10) - 1] : '')
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
  work.style.animationDelay = `${Math.min(index * 60, 1400)}ms`
  work.setAttribute('aria-label', `Play the message from ${item.name}`)

  const frame = document.createElement('div')
  frame.className = 'work-frame'

  const plate = document.createElement('div')
  plate.className = 'work-plate'

  if (item.posterUrl) {
    const img = document.createElement('img')
    img.src = item.posterUrl
    img.alt = ''
    img.loading = 'lazy'
    // An expired or missing poster falls back to the monogram panel.
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
  frame.append(plate)

  const label = document.createElement('div')
  label.className = 'work-label'

  const name = document.createElement('p')
  name.className = 'work-name'
  name.textContent = item.name

  const meta = document.createElement('p')
  meta.className = 'work-meta'
  meta.textContent = `No. ${numeral(index + 1)}`

  label.append(name, meta)

  if (item.message) {
    const note = document.createElement('p')
    note.className = 'work-note'
    note.textContent = item.message
    label.append(note)
  }

  work.append(frame, label)
  work.addEventListener('click', () => open(index))
  return work
}

/* -------------------------------------------------------------- lightbox */

function open(index) {
  if (index < 0 || index >= submissions.length) return
  current = index
  const item = submissions[index]

  if (lightbox.hidden) lastFocused = document.activeElement
  lbVideo.src = item.videoUrl
  lbName.textContent = item.name
  lbMessage.textContent = item.message || ''
  lbMessage.hidden = !item.message
  lbIndex.textContent = `No. ${numeral(index + 1)} of ${submissions.length}`
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

// Roll into the next film, like a reel.
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
    board.innerHTML =
      '<p class="board-status">The walls are still bare. Check back once the first films arrive.</p>'
  } else {
    const n = submissions.length
    $('subtitle').textContent = `${n} ${n === 1 ? 'work' : 'works'}, assembled by the people who love you.`
    const frag = document.createDocumentFragment()
    submissions.forEach((item, i) => frag.append(buildWork(item, i)))
    board.append(frag)
  }
} catch (err) {
  status.textContent = `${err.message} Try refreshing the page.`
}
