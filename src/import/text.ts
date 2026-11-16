import type { OTFont } from 'opentype.js';
import { capHeightUnits, placeContours, textToContours } from '../text/outline';
import { guessFont, type FontId } from '../text/fonts-guess';
import type { RawShape, TextItem } from './shape';

/** Turn text found in a drawing into closed outlines, using whichever bundled font is closest. Pure: the caller supplies the fonts. */
export async function textItemsToShapes(items: TextItem[], getFont: (id: FontId) => Promise<OTFont>): Promise<{ shapes: RawShape[]; failed: number }> {
  const shapes: RawShape[] = [];
  let failed = 0;
  for (const it of items) {
    if (!it.text.trim() || !(it.size > 0)) continue;
    try {
      const font = await getFont(guessFont(it.family, it.weight));
      const cap = it.sizeIs === 'cap' ? it.size : (it.size * capHeightUnits(font)) / font.unitsPerEm;
      const t = textToContours(font, it.text, { capHeight: cap, align: it.anchor === 'middle' ? 'center' : it.anchor === 'end' ? 'right' : 'left' });
      for (const pts of placeContours(t.contours, it.x, it.y, it.rotation)) shapes.push({ layer: it.layer, pts, closed: true });
    } catch { failed++; }
  }
  return { shapes, failed };
}
