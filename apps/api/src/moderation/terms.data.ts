// Layer 1 slur and hate-term list (SO-41, PRD §27.2 "Slur and hate-term list:
// block at submission with a clear reason").
//
// Stored as hashes, never as the words: `hashTerm()` in filters.ts of each
// term after `normaliseToken()` (accents stripped, lower case, common
// look-alike digits and symbols mapped to letters, runs of three or more of a
// letter cut to two). Matching is by whole token, never by substring, so a
// word that merely contains a term (the Scunthorpe problem, "Niger",
// "Nigeria") is never blocked, and strong literary criticism is untouched.
//
// SEED LIST. Eleven unambiguous English racial, ethnic, homophobic and
// transphobic slurs, chosen so that none is an ordinary word in another sense
// (so "chink", "coon", "fag" and "dyke" are deliberately absent: "a chink in
// the armour" is common in reviews). The curated production list is an owner
// decision (DECISION NEEDED in tasks.md, SO-41). To regenerate:
//
//   npm run moderation:hash-terms -- < terms.txt   (one term per line)
//
// and paste the output here.

export const BLOCKED_TERM_HASHES: readonly string[] = [
  '939a4f8485d1b5d8c96f02e3961e4a3c',
  'aef02046b402dc5e432cc1a62dad1ff2',
  '0f0e680bf0fbbe29a6a2e25b5427423d',
  '8850319b2de7703cd6ee619a2337246b',
  'a81aec85ce060b931eeae67bd962756e',
  '20e8e9f18ee6ec9b307c071f847dd550',
  '3c40d59fcb1b319a12b74a05879e7745',
  'ece92d44c4f1fd25bb429cedf4cbb581',
  'a2e531cfda7c5a190cec0a4592583cef',
  '7dedf2b59cae411e4b072cac7a7830b9',
  'e2d6937a1e041208842e9c7eff8836dd',
];
