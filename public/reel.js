// Builds the physical film strip: the perforation column down the left edge,
// and the frames above and below the live one, which are stills from other
// people's submissions so the roll reads as continuous.

import { developStill } from '/film.js'

const reel = document.getElementById('reel')
const perf = document.getElementById('reelPerf')
// Every still frame on the strip, in order, so the roll runs off both edges.
const stills = [...document.querySelectorAll('.frame--still')]

/* ------------------------------------------------------- perforations */

// Super 8 carries exactly one perforation per frame, centred on that frame.
// Measuring the frames is the only way to keep them aligned as the strip
// resizes, and misaligned perfs are the first thing that reads as fake.
function layOutPerforations() {
  const reelBox = reel.getBoundingClientRect()
  if (!reelBox.height || !reelBox.width) return

  const frames = [...reel.querySelectorAll('.frame')]
  if (!frames.length) return

  // The strip runs down the screen on a phone and across it on a desktop, so
  // read the direction off the layout rather than assuming one.
  const framesEl = reel.querySelector('.reel-frames')
  const horizontal = getComputedStyle(framesEl).flexDirection.startsWith('row')

  const box = (el) => el.getBoundingClientRect()
  const along = (r) => (horizontal ? r.left : r.top)
  const size = (r) => (horizontal ? r.width : r.height)
  const extent = horizontal ? reelBox.width : reelBox.height
  const origin = horizontal ? reelBox.left : reelBox.top

  const pitch =
    frames.length > 1
      ? along(box(frames[1])) - along(box(frames[0]))
      : size(box(frames[0]))
  if (!pitch) return

  const firstCentre = along(box(frames[0])) + size(box(frames[0])) / 2 - origin

  perf.textContent = ''
  // Run past both ends so the row never stops short of the strip edge.
  for (let i = -2; i <= frames.length + 2; i++) {
    const at = firstCentre + pitch * i
    if (at < -pitch || at > extent + pitch) continue
    const hole = document.createElement('span')
    hole.className = 'perf'
    hole.style[horizontal ? 'left' : 'top'] = `${(at / extent) * 100}%`
    perf.append(hole)
  }
}

layOutPerforations()
addEventListener('resize', layOutPerforations)
// Frame boxes are not final until fonts and layout settle.
requestAnimationFrame(layOutPerforations)
setTimeout(layOutPerforations, 250)

/* ----------------------------------------------------- neighbour frames */

const FALLBACK = [
  '/img/tiles/dale.jpg',
  '/img/tiles/ridge.jpg',
  '/img/tiles/valley.jpg',
  '/img/tiles/coast.jpg',
  '/img/tiles/river.jpg',
]

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // Presigned R2 URLs need this for the canvas to stay untainted.
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

// Put the neighbours through the same film pipeline so the whole roll matches
// rather than having a graded centre frame between two clean photos.
async function dress(el, src) {
  try {
    const img = await loadImage(src)
    const developed = developStill(img, 480, 360)
    el.style.backgroundImage = `url(${developed || src})`
  } catch {
    // A neighbour frame is decoration; an unreachable one just stays dark.
    el.style.backgroundImage = ''
  }
}

async function fillNeighbours() {
  let frames = []
  try {
    const res = await fetch('/api/reel?limit=8')
    frames = (await res.json()).frames ?? []
  } catch {
    frames = []
  }

  // Before anyone has sent anything the roll would be empty, so fall back to
  // the same photos the tiles use.
  const pool = frames.length >= 2 ? frames : FALLBACK
  const first = Math.floor(Math.random() * pool.length)

  // Walk the pool so neighbouring frames are never the same picture.
  await Promise.all(
    stills.map((el, i) => dress(el, pool[(first + i) % pool.length])),
  )
}

fillNeighbours()

/* --------------------------------------------------------- base grain */

// Grain on the film base around the strip. Drawn per pixel so the mean lands
// exactly on the base colour: a CSS screen blend can only ever lighten, which
// is what left the page sitting paler than the film. Rendered small and
// stretched, so it is granular but not razor-edged like digital static.
function startBaseGrain() {
  const canvas = document.createElement('canvas')
  canvas.className = 'bg-grain'
  canvas.setAttribute('aria-hidden', 'true')
  document.body.prepend(canvas)

  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return

  const SCALE = 3 // render at a third and let the upscale soften it
  const BASE = [10, 9, 8] // #0a0908
  let w = 0
  let h = 0

  const fit = () => {
    w = Math.max(2, Math.ceil(window.innerWidth / SCALE))
    h = Math.max(2, Math.ceil(window.innerHeight / SCALE))
    canvas.width = w
    canvas.height = h
  }

  const draw = () => {
    const frame = ctx.createImageData(w, h)
    const px = frame.data
    for (let i = 0; i < px.length; i += 4) {
      // Three uniforms summed approximates a normal distribution, centred on
      // zero, so grain darkens as often as it lightens.
      const n = (Math.random() + Math.random() + Math.random() - 1.5) * 7
      px[i] = BASE[0] + n
      px[i + 1] = BASE[1] + n
      px[i + 2] = BASE[2] + n
      px[i + 3] = 255
    }
    ctx.putImageData(frame, 0, 0)
  }

  fit()
  draw()
  addEventListener('resize', () => {
    fit()
    draw()
  })

  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // Slow enough to read as film rather than television static.
    setInterval(() => {
      if (!document.hidden) draw()
    }, 110)
  }
}

startBaseGrain()

/* --------------------------------------------------------- strip drift */

// The roll creeps very slightly, the way a strip does on a light table.
if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  let t = 0
  const drift = () => {
    t += 0.006
    reel.style.setProperty('--drift', `${(Math.sin(t) * 0.9).toFixed(2)}px`)
    requestAnimationFrame(drift)
  }
  requestAnimationFrame(drift)
}
