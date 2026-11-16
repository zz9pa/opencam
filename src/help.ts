import { marked } from 'marked';
// The user guide is the single source of truth; this page just renders it.
import guide from '../docs/USER_GUIDE.md?raw';

const root = document.getElementById('content')!;
root.innerHTML = marked.parse(guide, { async: false }) as string;
if (new URLSearchParams(location.search).has('embed')) document.body.classList.add('embed');

// Give every heading an anchor id (GitHub style: lower case, punctuation dropped, spaces to hyphens) so links work.
const heads = [...root.querySelectorAll<HTMLElement>('h1, h2, h3')];
heads.forEach(h => { h.id = (h.textContent ?? '').toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-'); });

// ---- Contents sidebar (h2 and h3) with the current section highlighted ----
const toc = document.getElementById('toc')!;
const links = new Map<string, HTMLAnchorElement>();
for (const h of heads.filter(h => h.tagName !== 'H1' && h.textContent !== 'Contents')) {
  const a = document.createElement('a');
  a.href = `#${h.id}`; a.textContent = h.textContent!;
  if (h.tagName === 'H3') a.className = 'sub';
  toc.appendChild(a); links.set(h.id, a);
}
const io = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    links.forEach(l => l.classList.remove('active'));
    const l = links.get((e.target as HTMLElement).id);
    l?.classList.add('active');
    l?.scrollIntoView({ block: 'nearest' });
  }
}, { rootMargin: '-70px 0px -75% 0px' });
heads.forEach(h => io.observe(h));

// ---- Search: sections (heading + the text under it) ----
interface Section { id: string; title: string; text: string }
const sections: Section[] = [];
heads.filter(h => h.tagName !== 'H1' && h.textContent !== 'Contents').forEach(h => {
  let text = '';
  for (let n = h.nextElementSibling; n && !/^H[123]$/.test(n.tagName); n = n.nextElementSibling) text += ' ' + (n.textContent ?? '');
  sections.push({ id: h.id, title: h.textContent ?? '', text: text.replace(/\s+/g, ' ').trim() });
});
const q = document.getElementById('q') as HTMLInputElement;
const box = document.getElementById('results')!;
const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
q.addEventListener('input', () => {
  const terms = q.value.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (!terms.length) { box.style.display = 'none'; return; }
  const scored = sections.map(s => {
    const t = s.title.toLowerCase(), x = s.text.toLowerCase();
    if (!terms.every(w => t.includes(w) || x.includes(w))) return null;
    const score = terms.reduce((a, w) => a + (t.includes(w) ? 10 : 0) + (x.split(w).length - 1), 0);
    const at = x.indexOf(terms[0]);
    const snippet = at < 0 ? s.text.slice(0, 110) : s.text.slice(Math.max(0, at - 50), at + 90);
    return { s, score, snippet };
  }).filter((r): r is NonNullable<typeof r> => !!r).sort((a, b) => b.score - a.score).slice(0, 8);
  box.innerHTML = scored.length
    ? scored.map(r => `<a href="#${r.s.id}"><b>${esc(r.s.title)}</b><small>&hellip;${esc(r.snippet)}&hellip;</small></a>`).join('')
    : '<a><small>No matches. Try a shorter word, e.g. "dowel" or "tab".</small></a>';
  box.style.display = 'block';
});
box.addEventListener('click', () => { box.style.display = 'none'; });
document.addEventListener('click', e => { if (!box.contains(e.target as Node) && e.target !== q) box.style.display = 'none'; });
q.addEventListener('keydown', e => { if (e.key === 'Escape') { q.value = ''; box.style.display = 'none'; } });
addEventListener('keydown', e => { if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); } });

if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
