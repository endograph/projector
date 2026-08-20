/**
 * Ray/wash variant switcher — a scratch tool, not part of the design.
 *
 * A variant is a block of CSS custom-property overrides in style.css keyed on
 * :root[data-variant="x"]. This file picks one (?variant=f2, or the stored
 * choice) and draws the corner picker. Retired explorations live in
 * archive/variants-a-e.css.
 *
 * ?bare=1 suppresses the picker — that's what compare.html's frames use, so
 * the pickers don't stack up inside every pane.
 *
 * Retire it by deleting this file, its two script tags in index.html, the
 * variant blocks in style.css, and compare.html.
 */

/** The blessed design. A bare URL is always this, never a stored choice. */
export const BLESSED = 'f'

export const VARIANTS = [
  { id: 'f', label: 'blessed', note: 'wash as-is, masked to a wedge off the target' },
  { id: 'f2', label: 'from target', note: 'wash starts at the target, builds outward' },
  { id: 'f3', label: 'rays', note: 'hues fan out as rays from the target' },
]

const params = new URLSearchParams(location.search)
const BARE = params.get('bare') === '1'

/**
 * The URL decides, and nothing else. A bare address is always the blessed
 * design — a stored preference meant you could be looking at last week's
 * experiment without knowing it, which is the wrong default for the one URL
 * everybody opens by reflex. The corner picker rewrites the query string, so
 * a chosen variant still survives reload and is shareable.
 */
function initial() {
  const q = params.get('variant')
  return q && VARIANTS.some((v) => v.id === q) ? q : BLESSED
}

export function apply(id) {
  document.documentElement.dataset.variant = id
}

apply(initial())

if (!BARE) {
  // Deliberately plain: this control is scaffolding, so it shouldn't read as
  // part of the page's design language.
  const wrap = document.createElement('div')
  wrap.style.cssText = [
    'position:fixed',
    'right:12px',
    'bottom:12px',
    'z-index:9999',
    'display:flex',
    'gap:6px',
    'align-items:center',
    'padding:6px 8px',
    'border-radius:8px',
    'background:rgba(20,20,20,0.82)',
    'color:#fff',
    'font:11px ui-monospace,SFMono-Regular,Menlo,monospace',
    'backdrop-filter:blur(6px)',
  ].join(';')

  for (const v of VARIANTS) {
    const b = document.createElement('button')
    b.textContent = v.id
    b.title = `${v.label} — ${v.note}`
    b.style.cssText = [
      'width:22px',
      'height:22px',
      'border:0',
      'border-radius:5px',
      'cursor:pointer',
      'font:inherit',
      'color:inherit',
      'background:transparent',
    ].join(';')
    b.addEventListener('click', () => {
      apply(v.id)
      const url = new URL(location.href)
      if (v.id === BLESSED) url.searchParams.delete('variant')
      else url.searchParams.set('variant', v.id)
      history.replaceState(null, '', url)
      paint()
    })
    wrap.append(b)
  }

  const link = document.createElement('a')
  link.href = './compare.html'
  link.textContent = 'compare'
  link.style.cssText = 'color:#9ecbff;text-decoration:none;margin-left:2px'
  wrap.append(link)

  const paint = () => {
    const cur = document.documentElement.dataset.variant
    for (const b of wrap.querySelectorAll('button')) {
      const on = b.textContent === cur
      b.style.background = on ? '#fff' : 'transparent'
      b.style.color = on ? '#111' : '#fff'
    }
  }

  addEventListener('DOMContentLoaded', () => {
    document.body.append(wrap)
    paint()
  })
}
