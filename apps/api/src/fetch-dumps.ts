// Dump downloader (the other half of FN-20).
//
//   npm run ingest:fetch -- authors works reading-log
//   npm run ingest:fetch -- editions
//
// Resumable, because 2.9 GB over a home connection will be interrupted and
// starting over each time is how this step never gets done. Re-running picks
// up from the byte already on disk via a Range request.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DUMP_URLS } from './catalog/ingest/dump.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../../data', import.meta.url));

const mb = (n: number) => (n / 1_048_576).toFixed(0);
const gb = (n: number) => (n / 1_073_741_824).toFixed(2);
// Rates below 1 MB/s are common on a home line, and rounding them to "0 MB/s"
// makes a working download look stalled.
const rateText = (bytesPerSecond: number) =>
  bytesPerSecond >= 1_048_576
    ? `${(bytesPerSecond / 1_048_576).toFixed(1)} MB/s`
    : `${(bytesPerSecond / 1024).toFixed(0)} kB/s`;

function bar(done: number, total: number, width = 30) {
  if (!total) return '';
  const filled = Math.round((done / total) * width);
  return '[' + '='.repeat(filled) + ' '.repeat(width - filled) + ']';
}

async function download(name: keyof typeof DUMP_URLS, dir: string): Promise<void> {
  const url = DUMP_URLS[name];
  const target = path.join(dir, path.basename(new URL(url).pathname));
  const partial = target + '.part';

  if (fs.existsSync(target)) {
    console.log(`${name}: already have ${path.basename(target)} (${gb(fs.statSync(target).size)} GB)`);
    return;
  }

  // Resume from whatever a previous attempt managed.
  const already = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  if (already) console.log(`${name}: resuming at ${mb(already)} MB`);

  const res = await fetch(url, {
    headers: {
      // Open Library asks that bulk clients identify themselves.
      'User-Agent': 'Flyleaf/1.0 (+https://flyleaf.app; catalog ingest)',
      ...(already ? { Range: `bytes=${already}-` } : {}),
    },
  });

  if (!res.ok && res.status !== 206) {
    throw new Error(`${name}: HTTP ${res.status} ${res.statusText}`);
  }
  // A 200 in reply to a Range request means the server ignored it. Starting
  // over is correct; appending would silently corrupt the file.
  const resuming = res.status === 206;
  if (already && !resuming) {
    console.log(`${name}: server does not support resume, starting over`);
    fs.rmSync(partial, { force: true });
  }

  const declared = Number(res.headers.get('content-length') ?? 0);
  const total = declared + (resuming ? already : 0);
  let done = resuming ? already : 0;
  let lastPrint = 0;
  const started = Date.now();

  if (!res.body) throw new Error(`${name}: no response body`);

  const out = fs.createWriteStream(partial, { flags: resuming ? 'a' : 'w' });
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);

  source.on('data', (chunk: Buffer) => {
    done += chunk.length;
    const now = Date.now();
    if (now - lastPrint < 1000) return;
    lastPrint = now;
    const rate = (done - (resuming ? already : 0)) / ((now - started) / 1000);
    const eta = total && rate ? Math.round((total - done) / rate) : 0;
    process.stdout.write(
      `\r  ${bar(done, total)} ${gb(done)}/${gb(total)} GB  ` +
      `${rateText(rate)}  ETA ${Math.floor(eta / 60)}m${String(eta % 60).padStart(2, '0')}s   `);
  });

  await pipeline(source, out);
  process.stdout.write('\n');

  // A saved HTML error page is still a file, and it fails much later and far
  // less clearly -- in the middle of gunzip, three commands from now.
  const head = Buffer.alloc(2);
  const fd = fs.openSync(partial, 'r');
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  if (head[0] !== 0x1f || head[1] !== 0x8b) {
    throw new Error(
      `${name}: downloaded file is not gzip (starts ${head.toString('hex')}). ` +
      `Probably an error page. Delete ${partial} and retry.`);
  }

  fs.renameSync(partial, target);
  console.log(`${name}: ${path.basename(target)} (${gb(fs.statSync(target).size)} GB)`);
}

async function main() {
  const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dirFlag = process.argv.indexOf('--dir');
  const dir = dirFlag !== -1 ? process.argv[dirFlag + 1]! : DEFAULT_DIR;

  const valid = Object.keys(DUMP_URLS);
  const unknown = names.filter((n) => !valid.includes(n));
  if (names.length === 0 || unknown.length) {
    console.error(
      `Usage: npm run ingest:fetch -- <${valid.join('|')}> [...] [--dir <path>]\n\n` +
      `Recommended first run:\n` +
      `  npm run ingest:fetch -- authors works reading-log\n\n` +
      `That is ~3.5 GB. The editions dump is another 9.2 GB and is optional.\n` +
      `Faster over torrent: https://archive.org/details/ol_exports?sort=-publicdate`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(dir, { recursive: true });
  console.log(`downloading into ${dir}\n`);
  for (const name of names) {
    await download(name as keyof typeof DUMP_URLS, dir);
  }
  console.log(`\nNext:\n  npm run ingest -- --type authors --file ${path.join(dir, 'ol_dump_authors_latest.txt.gz')}`);
}

main().catch((err) => {
  console.error('\n' + String(err instanceof Error ? err.message : err));
  console.error('\nRe-run the same command to resume from where it stopped.');
  process.exit(1);
});
