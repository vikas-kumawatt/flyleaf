// Fixed inputs for the share-card tests (ST-07, ST-08): a cover drawn here
// (no file, no network), the hard strings every text field must survive, and
// one model per template for the golden images.

import { toPng } from '../cards/render.js';
import type { CardImage, FinishModel, ProfileModel, ReviewModel, StatModel, WallModel } from '../cards/templates.js';

const COVER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600">
<rect width="400" height="600" fill="#2F5D50"/><circle cx="200" cy="260" r="120" fill="#C8951F"/>
<rect x="40" y="460" width="320" height="40" fill="#F7F7F5"/></svg>`;

/** A JPEG-free, deterministic cover: a PNG drawn by resvg. */
export const COVER_PNG = toPng(COVER_SVG, 400);
export const cover: CardImage = { uri: `data:image/png;base64,${COVER_PNG.toString('base64')}` };

const cp = (...points: number[]) => String.fromCodePoint(...points);

/** Every text field is tried with each of these (ST-07: long, RTL, CJK, emoji, empty). */
export const HARD_STRINGS: Record<string, string> = {
  long: 'The Extraordinarily Long and Winding Title of a Book That Never Seems to End, Being a Complete and Unabridged Account of Everything '.repeat(6),
  longWord: 'Pneumonoultramicroscopicsilicovolcanoconiosis'.repeat(8),
  arabic: 'مئة عام من العزلة، رواية للكاتب غابرييل غارسيا ماركيث',
  hebrew: `ספר טוב מאוד, I loved Piranesi so much, ממש אהבתי את הסוף 2024.`,
  cjk: '三体 ノルウェイの森 채식주의자 百年孤独 '.repeat(5),
  devanagari: 'गोदान — मुंशी प्रेमचंद का उपन्यास',
  emoji: `${cp(0x1f4da)}${cp(0x1f525)} ${cp(0x1f469, 0x1f3fd, 0x200d, 0x1f52c)} ${cp(0x1f1ee, 0x1f1f3)} ${cp(0x2764, 0xfe0f)}`.repeat(4),
  combining: 'Zalgo: Z' + cp(0x0351, 0x0352, 0x0357, 0x035b, 0x0300, 0x0301, 0x0302).repeat(6) + 'algo',
  // Every letter carrying the most marks cleanText keeps: still lays out.
  marksEverywhere: Array.from('abcdefghijklmnopqrstuvwxyzabcd', (c) => c + cp(0x0300, 0x0301, 0x0302, 0x0303)).join(''),
  controls: `Evil${cp(0x202e)}gnp.exe${cp(0x202c)} ${cp(0x0007)}name${cp(0x200f)}\n\twith tabs`,
  empty: '',
  blank: `  ${cp(0x200e)}\n\t ${cp(0xfeff)} `,
};

export const finishModel: FinishModel = {
  handle: 'aisha', title: 'Piranesi', author: 'Susanna Clarke', cover, rating: 4.5, hearted: true, finishedOn: '12 Oct 2026',
};
export const reviewModel: ReviewModel = {
  handle: 'tanvi', name: 'Tanvi', title: 'Piranesi', author: 'Susanna Clarke', cover, rating: 4,
  quote: `The beauty of the House is immeasurable; its kindness infinite. I loved every page of this strange, quiet book. ${cp(0x2764, 0xfe0f)}`,
};
export const statModel: StatModel = {
  handle: 'aisha', period: '2026', heading: 'Top genre', value: '12', caption: 'Fantasy', detail: '12 books',
  bars: [{ label: 'Fantasy', value: 12, text: '12' }, { label: 'Literary fiction', value: 8, text: '8' }, { label: 'خيال علمي', value: 3, text: '3' }],
  coverage: 'Based on 40 of 42 books — 2 have no genre.',
};
export const profileModel: ProfileModel = {
  handle: 'aisha', name: 'Aisha Khan', initials: 'AK', avatar: null, bio: `Reader of strange quiet books. ${cp(0x2728)} Bengaluru.`,
  favourites: [
    { title: 'Piranesi', author: 'Susanna Clarke', cover },
    { title: 'The Remains of the Day', author: 'Kazuo Ishiguro', cover: null },
    { title: '百年孤独', author: null, cover: null },
    { title: 'Beloved', author: 'Toni Morrison', cover },
  ],
  year: 2026, booksThisYear: 42, booksAllTime: 312,
};
export const wallModel: WallModel = {
  handle: 'aisha', name: 'Aisha Khan', layout: '4x4', count: 312, year: null,
  posters: Array.from({ length: 16 }, (_, i) => (i % 3 === 0 ? { title: `Book number ${i}`, author: 'An Author', cover: null } : { title: `Cover ${i}`, author: null, cover })),
};
