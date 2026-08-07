// Packs photo tiles into columns either side of the recording pane. Tiles are
// either 4:3 or 3:4, so the columns stay grid-like but end at different
// heights. Every few seconds the tiles physically swap places.

const mosaic = document.getElementById('form')
const pane = document.getElementById('pane')

let photos = []
try {
  photos = JSON.parse(document.getElementById('tileData').textContent)
} catch {
  photos = []
}

const MAX_TILT = 34 // degrees — deliberately dramatic
const SHUFFLE_MS = 4600
const FLIGHT_MS = 720
const COLUMNS_PER_SIDE = 2

// Landscape / portrait in a repeating but uneven pattern, so neighbouring
// columns rarely line up.
const RATIO_PATTERN = [
  '3 / 4',
  '4 / 3',
  '4 / 3',
  '3 / 4',
  '4 / 3',
  '3 / 4',
  '3 / 4',
  '4 / 3',
  '4 / 3',
  '3 / 4',
  '3 / 4',
  '4 / 3',
]

const tiles = []
const columns = []
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

function buildTile(photo, index) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'tile'
  el.style.setProperty('--ratio', RATIO_PATTERN[index % RATIO_PATTERN.length])
  el.style.animationDelay = `${index * 55}ms`
  el.setAttribute('aria-pressed', 'false')
  el.setAttribute('aria-label', photo.note || 'Photo')

  const inner = document.createElement('div')
  inner.className = 'tile-inner'

  const front = document.createElement('div')
  front.className = 'tile-face tile-front'
  const img = document.createElement('img')
  img.src = photo.src
  img.alt = ''
  img.draggable = false
  img.loading = index < 6 ? 'eager' : 'lazy'
  front.append(img)

  const back = document.createElement('div')
  back.className = 'tile-face tile-back'
  const note = document.createElement('p')
  note.textContent = photo.note || ''
  back.append(note)

  inner.append(front, back)
  el.append(inner)

  const tiltTo = (e) => {
    if (el.classList.contains('is-flipped')) return
    const r = el.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width - 0.5
    const y = (e.clientY - r.top) / r.height - 0.5
    el.style.setProperty('--rx', `${(-y * MAX_TILT).toFixed(2)}deg`)
    el.style.setProperty('--ry', `${(x * MAX_TILT).toFixed(2)}deg`)
  }
  const resetTilt = () => {
    el.style.setProperty('--rx', '0deg')
    el.style.setProperty('--ry', '0deg')
  }

  el.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') tiltTo(e)
  })
  el.addEventListener('pointerleave', resetTilt)

  el.addEventListener('click', () => {
    const flipped = el.classList.toggle('is-flipped')
    el.setAttribute('aria-pressed', String(flipped))
    resetTilt()
  })

  return el
}

function makeGroup(className) {
  const group = document.createElement('div')
  group.className = `col-group ${className}`
  for (let i = 0; i < COLUMNS_PER_SIDE; i++) {
    const col = document.createElement('div')
    col.className = 'col'
    group.append(col)
    columns.push(col)
  }
  return group
}

// Deal the tiles down the columns in their current order.
function deal(order) {
  order.forEach((el, i) => columns[i % columns.length].append(el))
}

// FLIP: measure where every tile is, move them, then animate each from where
// it used to be to where it now is, so the cards visibly fly between slots.
function shuffle(order) {
  const before = new Map()
  for (const el of tiles) before.set(el, el.getBoundingClientRect())

  deal(order)

  const moved = []
  for (const el of tiles) {
    const a = before.get(el)
    const b = el.getBoundingClientRect()
    const dx = a.left - b.left
    const dy = a.top - b.top
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue

    el.style.transition = 'none'
    el.style.transform = `translate(${dx}px, ${dy}px)`
    el.classList.add('is-flying')
    moved.push(el)
  }

  if (!moved.length) return

  // Force the browser to accept the starting offsets before animating away.
  void mosaic.offsetWidth

  moved.forEach((el, i) => {
    el.style.transition = `transform ${FLIGHT_MS}ms cubic-bezier(0.22, 0.9, 0.24, 1) ${i * 35}ms`
    el.style.transform = ''
  })

  setTimeout(() => {
    for (const el of moved) {
      el.style.transition = ''
      el.classList.remove('is-flying')
    }
  }, FLIGHT_MS + moved.length * 35 + 60)
}

if (photos.length) {
  const left = makeGroup('col-left')
  const right = makeGroup('col-right')
  mosaic.insertBefore(left, pane)
  mosaic.append(right)

  photos.forEach((photo, i) => tiles.push(buildTile(photo, i)))
  deal(tiles)

  if (!reduceMotion && tiles.length > 2) {
    let order = tiles.slice()
    setInterval(() => {
      if (document.hidden) return
      // Rotate by an amount coprime-ish with the count so tiles keep landing
      // somewhere new rather than cycling between two arrangements.
      const step = 3 % order.length || 1
      order = order.slice(step).concat(order.slice(0, step))
      shuffle(order)
    }, SHUFFLE_MS)
  }
}
