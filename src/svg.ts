import type { Loop } from './core/types';
import type { ParsedDrawing, RawShape, TextItem } from './import/shape';

const SVGNS = 'http://www.w3.org/2000/svg';
const NON_GEOMETRY = 'defs, clipPath, mask, marker, pattern, symbol, metadata, title, desc';

/**
 * Read an SVG into lines in mm (Y up), remembering layer names. Browser only (it needs real SVG geometry).
 * `unitScale` = mm per SVG user unit; leave it out to work it out from the file's width and viewBox.
 */
export function parseSvgRaw(text: string, opts: { unitScale?: number } = {}): ParsedDrawing {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('This file is not a valid SVG.');
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden';
  host.innerHTML = new XMLSerializer().serializeToString(doc.documentElement);
  document.body.appendChild(host);
  try {
    const svg = host.querySelector('svg') as SVGSVGElement | null;
    if (!svg) throw new Error('This file does not contain an SVG drawing.');
    const notes: string[] = [];
    const units = unitInfo(svg);
    const scale = opts.unitScale ?? units.mmPerUnit;
    if (opts.unitScale === undefined && !units.known) {
      notes.push('The file does not give a physical size (no width with units and viewBox), so 96 pixels = 1 inch is assumed. If sizes look wrong, change Units.');
    }
    expandUses(svg);

    const inGeometry = (el: Element) => !el.closest(NON_GEOMETRY);
    const hidden = (el: Element) => !!el.closest('[display="none"], [style*="display:none"], [style*="display: none"]');
    const images = [...svg.querySelectorAll('image')].filter(inGeometry).length;
    if (images) notes.push(`${images} image(s) were ignored.`);

    const rootInv = svg.getScreenCTM?.()?.inverse();

    // Text: collected here and turned into outlines by the app (with our own fonts) after the drawing is read.
    const texts: TextItem[] = [];
    svg.querySelectorAll<SVGTextElement>('text').forEach(el => {
      if (!inGeometry(el) || hidden(el)) return;
      const content = textOf(el);
      if (!content.trim()) return;
      const m = rootInv && el.getScreenCTM?.() ? rootInv.multiply(el.getScreenCTM()!) : null;
      const num = (v: string | null | undefined) => { const n = parseFloat((v ?? '').split(/[\s,]+/)[0]); return Number.isFinite(n) ? n : null; };
      const ts = el.querySelector('tspan');
      const x0 = num(el.getAttribute('x')) ?? num(ts?.getAttribute('x')) ?? 0;
      const y0 = num(el.getAttribute('y')) ?? num(ts?.getAttribute('y')) ?? 0;
      const q = m ? new DOMPoint(x0, y0).matrixTransform(m) : { x: x0, y: y0 };
      const cs = getComputedStyle(el);
      const fontSize = parseFloat(cs.fontSize) || 16;
      const k = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 1;
      const anchorRaw = (el.getAttribute('text-anchor') ?? /text-anchor:\s*(\w+)/.exec(el.getAttribute('style') ?? '')?.[1] ?? cs.textAnchor ?? 'start');
      texts.push({
        layer: layerOf(el, svg), text: content,
        x: q.x * scale, y: -q.y * scale,
        size: fontSize * k * scale, sizeIs: 'em',
        rotation: m ? (-Math.atan2(m.b, m.a) * 180) / Math.PI : 0,
        anchor: anchorRaw === 'middle' ? 'middle' : anchorRaw === 'end' ? 'end' : 'start',
        family: cs.fontFamily || 'sans-serif', weight: cs.fontWeight || 400,
      });
    });
    const shapes: RawShape[] = [];
    let hiddenCount = 0;
    svg.querySelectorAll<SVGGeometryElement>('path,rect,circle,ellipse,polygon,polyline,line').forEach(el => {
      if (!inGeometry(el)) return;
      if (hidden(el)) { hiddenCount++; return; }
      const layer = layerOf(el, svg);
      const m = rootInv && (el as SVGGraphicsElement).getScreenCTM?.() ? rootInv.multiply((el as SVGGraphicsElement).getScreenCTM()!) : null;
      const parts: { geom: SVGGeometryElement; temp: boolean }[] = [];
      if (el.tagName.toLowerCase() === 'path') {
        const d = el.getAttribute('d') ?? '';
        const subs = d.split(/(?=[Mm])/).filter(s => s.trim());
        if (subs.length <= 1) parts.push({ geom: el, temp: false });
        else subs.forEach(sub => {
          const p = document.createElementNS(SVGNS, 'path');
          p.setAttribute('d', sub);
          el.parentNode!.appendChild(p);
          parts.push({ geom: p as SVGGeometryElement, temp: true });
        });
      } else parts.push({ geom: el, temp: false });
      for (const { geom, temp } of parts) {
        let len = 0;
        try { len = geom.getTotalLength(); } catch { len = 0; }
        if (!(len > 0)) { if (temp) geom.remove(); continue; }
        const lenMm = len * scale;
        const n = Math.min(4000, Math.max(24, Math.ceil(lenMm / 0.5)));
        const map = (pt: DOMPoint | SVGPoint) => {
          const q = m ? new DOMPoint(pt.x, pt.y).matrixTransform(m) : pt;
          return { x: q.x * scale, y: -q.y * scale };
        };
        const pts: Loop = [];
        for (let i = 0; i < n; i++) pts.push(map(geom.getPointAtLength((len * i) / n)));
        const end = map(geom.getPointAtLength(len));
        const tag = geom.tagName.toLowerCase();
        const closed = Math.hypot(end.x - pts[0].x, end.y - pts[0].y) < 0.01 || /[zZ]\s*$/.test(geom.getAttribute('d') ?? '')
          || ['rect', 'circle', 'ellipse', 'polygon'].includes(tag);
        if (!closed) pts.push(end);
        if (pts.length >= 2 && (closed ? pts.length >= 3 : true)) shapes.push({ layer, pts, closed });
        if (temp) geom.remove();
      }
    });
    if (hiddenCount) notes.push(`${hiddenCount} hidden item(s) were skipped.`);
    if (!shapes.length && !texts.length) notes.push('No lines were found in this file.');
    return { shapes, texts, notes, fileUnits: units.name, scaleToMm: scale };
  } finally {
    host.remove();
  }
}

/** The words of a <text>, putting a new line wherever a later <tspan> starts a new row. */
function textOf(el: Element): string {
  let out = '', first = true;
  el.childNodes.forEach(n => {
    if (n.nodeType === 3) { out += n.textContent ?? ''; return; }
    if (n.nodeType === 1 && (n as Element).tagName.toLowerCase() === 'tspan') {
      const t = n as Element;
      if (!first && (t.hasAttribute('dy') || t.hasAttribute('y'))) out += '\n';
      out += t.textContent ?? '';
      first = false;
    }
  });
  return out.replace(/[ \t]+/g, ' ').replace(/^\s+|\s+$/gm, '');
}

/** Replace each <use> with a copy of what it points to, so the copy is imported like any other shape. */
function expandUses(svg: SVGSVGElement) {
  for (let pass = 0; pass < 5; pass++) {
    const uses = [...svg.querySelectorAll('use')];
    if (!uses.length) return;
    for (const u of uses) {
      const href = u.getAttribute('href') ?? u.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? u.getAttribute('xlink:href') ?? '';
      const target = href.startsWith('#') ? svg.querySelector(`[id="${href.slice(1).replace(/"/g, '')}"]`) : null;
      const g = document.createElementNS(SVGNS, 'g');
      const x = u.getAttribute('x') ?? '0', y = u.getAttribute('y') ?? '0';
      g.setAttribute('transform', `${u.getAttribute('transform') ?? ''} translate(${x} ${y})`);
      const lab = u.getAttribute('inkscape:label');
      if (lab) g.setAttribute('inkscape:label', lab);
      if (target) {
        const clone = target.cloneNode(true) as Element;
        clone.removeAttribute('id');
        if (clone.tagName.toLowerCase() === 'symbol') [...clone.childNodes].forEach(c => g.appendChild(c));
        else g.appendChild(clone);
      }
      u.replaceWith(g);
    }
  }
}

function layerOf(el: Element, root: Element): string {
  for (let n: Element | null = el.parentElement; n && n !== root.parentElement; n = n.parentElement) {
    const l = n.getAttribute('inkscape:label') ?? n.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'label');
    if (l) return l;
    if (n.tagName.toLowerCase() === 'g' && n.id && n !== root) return n.id;
  }
  return 'Drawing';
}

/** Millimetres per SVG user unit, from the width attribute and the viewBox. */
function unitInfo(svg: SVGSVGElement): { mmPerUnit: number; known: boolean; name: string | null } {
  const w = svg.getAttribute('width') ?? '';
  const vb = svg.viewBox.baseVal;
  const m = w.match(/^\s*([\d.]+)\s*(mm|cm|in|px|pt|pc)?\s*$/);
  const mmPer: Record<string, number> = { mm: 1, cm: 10, in: 25.4, px: 25.4 / 96, pt: 25.4 / 72, pc: 25.4 / 6 };
  const names: Record<string, string> = { mm: 'millimetres', cm: 'centimetres', in: 'inches', px: 'pixels', pt: 'points', pc: 'picas' };
  if (m && m[2] && vb && vb.width > 0) {
    return { mmPerUnit: (parseFloat(m[1]) * mmPer[m[2]]) / vb.width, known: true, name: names[m[2]] };
  }
  if (m && !m[2] && vb && vb.width > 0) {
    return { mmPerUnit: (parseFloat(m[1]) * mmPer.px) / vb.width, known: true, name: 'pixels' };
  }
  // No viewBox: user units are CSS pixels (96 per inch).
  if (m && m[2] && !(vb && vb.width > 0)) return { mmPerUnit: mmPer.px, known: true, name: 'pixels' };
  return { mmPerUnit: mmPer.px, known: false, name: null };
}
