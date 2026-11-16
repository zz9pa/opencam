import { parse, type OTFont } from 'opentype.js';
// Bundled open-licence fonts (SIL Open Font License). Loaded only when text is first used.
import sansUrl from '@fontsource/roboto/files/roboto-latin-400-normal.woff?url';
import sansBoldUrl from '@fontsource/roboto/files/roboto-latin-700-normal.woff?url';
import serifUrl from '@fontsource/roboto-slab/files/roboto-slab-latin-700-normal.woff?url';
import monoUrl from '@fontsource/roboto-mono/files/roboto-mono-latin-500-normal.woff?url';
import scriptUrl from '@fontsource/pacifico/files/pacifico-latin-400-normal.woff?url';
import condensedUrl from '@fontsource/oswald/files/oswald-latin-700-normal.woff?url';
import type { FontId } from './fonts-guess';

export { guessFont, type FontId } from './fonts-guess';

export const FONTS: { id: FontId; label: string; url: string }[] = [
  { id: 'sans', label: 'Sans-serif', url: sansUrl },
  { id: 'sansbold', label: 'Sans-serif bold', url: sansBoldUrl },
  { id: 'condensed', label: 'Condensed bold (narrow)', url: condensedUrl },
  { id: 'serif', label: 'Slab serif bold', url: serifUrl },
  { id: 'mono', label: 'Monospace', url: monoUrl },
  { id: 'script', label: 'Script (flowing)', url: scriptUrl },
];

const cache = new Map<FontId, Promise<OTFont>>();

export function loadFont(id: FontId): Promise<OTFont> {
  let p = cache.get(id);
  if (!p) {
    const f = FONTS.find(x => x.id === id)!;
    p = fetch(f.url).then(r => { if (!r.ok) throw new Error(`Could not load the ${f.label} font.`); return r.arrayBuffer(); }).then(b => parse(b));
    cache.set(id, p);
  }
  return p;
}
