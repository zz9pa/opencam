// Panel layout: every h2 heading becomes a numbered "step" plate that folds away. Content is moved, never copied, so every
// element keeps its id and the rest of the program does not know the difference. Fold state is remembered in this browser.
const KEY = 'open-cam.folded';
const folded: Record<string, boolean> = (() => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; } })();
/** Optional parts start folded; the main path (drawing, machine, operations) starts open. */
const START_FOLDED = ['cutting-both-sides-turning-the-stock-over', 'parts-longer-than-your-machine-splitting'];

for (const h of [...document.querySelectorAll<HTMLElement>('aside h2')]) {
  const key = h.dataset.help ?? (h.textContent ?? '');
  const step = document.createElement('section'), body = document.createElement('div');
  step.className = 'step'; body.className = 'body';
  h.parentElement!.insertBefore(step, h);
  let n = h.nextSibling;
  while (n && !(n instanceof HTMLElement && (n.tagName === 'H2' || n.id === 'actions' || n.tagName === 'SECTION'))) { const next = n.nextSibling; body.appendChild(n); n = next; }
  step.append(h, body);
  const fold = (v: boolean) => { step.classList.toggle('collapsed', v); h.setAttribute('aria-expanded', String(!v)); };
  fold(folded[key] ?? START_FOLDED.includes(key));
  h.tabIndex = 0; h.setAttribute('role', 'button');
  const toggle = () => { const v = !step.classList.contains('collapsed'); fold(v); folded[key] = v; try { localStorage.setItem(KEY, JSON.stringify(folded)); } catch { /* not remembered */ } };
  h.addEventListener('click', e => { if (!(e.target as HTMLElement).closest('.helpbtn')) toggle(); });
  h.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === h) { e.preventDefault(); toggle(); } });
}

// A draggable divider between the control panel and the drawing area (also arrow keys when focused). Width is remembered.
{
  const aside = document.querySelector('aside')!;
  const bar = document.createElement('div');
  bar.id = 'splitter'; bar.tabIndex = 0; bar.setAttribute('role', 'separator'); bar.setAttribute('aria-orientation', 'vertical');
  bar.title = 'Drag to resize the panel (double-click to reset)';
  aside.after(bar);
  const MIN = 260, DEFAULT = 360, WKEY = 'open-cam.panelWidth';
  const max = () => Math.max(MIN, Math.min(900, innerWidth - 240));
  const set = (w: number, save = true) => {
    const v = Math.round(Math.max(MIN, Math.min(max(), w)));
    aside.style.width = v + 'px'; bar.setAttribute('aria-valuenow', String(v));
    dispatchEvent(new Event('resize')); // the drawing redraws itself to its new size
    if (save) try { localStorage.setItem(WKEY, String(v)); } catch { /* not remembered */ }
  };
  const saved = Number(localStorage.getItem(WKEY));
  if (saved) set(saved, false);
  bar.addEventListener('pointerdown', e => {
    bar.setPointerCapture(e.pointerId); bar.classList.add('drag'); document.body.style.userSelect = 'none';
    const move = (ev: PointerEvent) => set(ev.clientX - aside.getBoundingClientRect().left);
    const up = () => { bar.classList.remove('drag'); document.body.style.userSelect = ''; bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); };
    bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up);
  });
  bar.addEventListener('dblclick', () => set(DEFAULT));
  bar.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); set(aside.getBoundingClientRect().width + (e.key === 'ArrowRight' ? 20 : -20)); }
  });
}
