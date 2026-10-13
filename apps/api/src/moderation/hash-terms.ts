// Prints the hashes for terms.data.ts: one term per line on stdin (SO-41).
// The words never enter the repository; only their hashes do.
//
//   npm run moderation:hash-terms -- < terms.txt

import { hashTerm } from './filters.js';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const hashes = input.split(/\r?\n/).map((t) => t.trim()).filter(Boolean).map(hashTerm);
  for (const h of [...new Set(hashes)]) console.log(`  '${h}',`);
});
