export type FontId = 'sans' | 'sansbold' | 'serif' | 'mono' | 'script' | 'condensed';

/** Pick the closest bundled font for a font family / weight named in a drawing file. */
export function guessFont(family: string, weight: string | number = 400): FontId {
  const f = family.toLowerCase();
  const bold = /bold|black|heavy/.test(String(weight).toLowerCase()) || +weight >= 600;
  if (/mono|courier|consol|typewriter|code/.test(f)) return 'mono';
  if (/script|cursive|brush|hand/.test(f)) return 'script';
  if (/condensed|narrow|oswald|impact|league/.test(f)) return 'condensed';
  if ((/serif/.test(f) && !/sans/.test(f)) || /times|georgia|garamond|palatino|slab|roman|book/.test(f)) return 'serif';
  return bold ? 'sansbold' : 'sans';
}
