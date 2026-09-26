// Open Library as a CatalogSource (PV-07).
//
// Every request goes through the ONE shared OutboundClient (platform/
// outbound.ts): its rate limit and circuit breaker are shared with every
// other caller that reaches Open Library, because two limiters at "3 per
// second" together exceed it (architecture §5.2).

import { cleanIsbn, isValidIsbn10, isValidIsbn13 } from '../../catalog/isbn.js';
import { normaliseAuthor, normaliseEdition, normaliseWork } from '../../catalog/ingest/normalise.js';
import type { OutboundClient } from '../../platform/outbound.js';
import type { AuthorRow, CatalogSource, CoverSize, EditionRow, SearchWork, WorkRow } from './index.js';

const OL = 'https://openlibrary.org';
const COVERS = 'https://covers.openlibrary.org';

/** Only the fields gap-fill stores. Asking for fewer makes their query far cheaper. */
const OL_FIELDS = 'key,title,first_publish_year,cover_i,author_key,author_name,edition_count';

/** A search waits at most this long: the user is waiting on it (FN-32). */
const SEARCH_TIMEOUT_MS = 2_500;

type OlSearchResponse = {
  docs?: {
    key?: string;
    title?: string;
    first_publish_year?: number;
    cover_i?: number;
    author_key?: string[];
    author_name?: string[];
    edition_count?: number;
  }[];
};

export function parseOlSearch(body: OlSearchResponse): SearchWork[] {
  const docs = Array.isArray(body.docs) ? body.docs : [];
  const out: SearchWork[] = [];

  for (const d of docs) {
    const key = typeof d.key === 'string' ? d.key : null;
    const title = typeof d.title === 'string' ? d.title.trim() : '';
    if (!key || !key.startsWith('/works/') || !title) continue;

    const authorKeys = (d.author_key ?? []).filter((k) => typeof k === 'string');
    const authorNames = (d.author_name ?? []).filter((n) => typeof n === 'string');
    // Same filter rule as the dump ingest (FN-22): no author, not a book we
    // can meaningfully show. Applying it in both places is what keeps the
    // gap-filled catalog and the ingested catalog the same shape.
    if (authorKeys.length === 0 || authorNames.length === 0) continue;

    out.push({
      olWorkKey: key,
      title,
      firstPublishYear: typeof d.first_publish_year === 'number' ? d.first_publish_year : null,
      coverId: typeof d.cover_i === 'number' && d.cover_i > 0 ? d.cover_i : null,
      // search.json returns bare ids ("OL23919A"); the dumps use full paths.
      // Normalising here means both sources land on the same rows.
      authorKeys: authorKeys.map((k) => (k.startsWith('/authors/') ? k : `/authors/${k}`)),
      authorNames,
      editionCount: typeof d.edition_count === 'number' ? d.edition_count : 0,
    });
  }

  return out;
}

/** `OL45804W` or `/works/OL45804W` -> `/works/OL45804W`; anything else -> null. */
function olKey(kind: 'works' | 'authors', suffix: 'W' | 'A', value: string): string | null {
  const m = new RegExp(`^(?:/${kind}/)?(OL\\d+${suffix})$`).exec(value.trim());
  return m ? `/${kind}/${m[1]}` : null;
}

export class OpenLibrarySource implements CatalogSource {
  constructor(private readonly client: OutboundClient) {}

  async search(query: string, limit: number): Promise<SearchWork[]> {
    const q = query.trim();
    if (q.length < 3) return [];
    const url = `${OL}/search.json?q=${encodeURIComponent(q)}&limit=${limit}&fields=${OL_FIELDS}`;
    const result = await this.client.getJson<OlSearchResponse>(url, { timeoutMs: SEARCH_TIMEOUT_MS });
    return result.ok ? parseOlSearch(result.data) : [];
  }

  async lookupIsbn(isbn: string): Promise<EditionRow | null> {
    const clean = cleanIsbn(isbn);
    if (!isValidIsbn10(clean) && !isValidIsbn13(clean)) return null;
    const result = await this.client.getJson<Record<string, unknown>>(`${OL}/isbn/${clean}.json`);
    if (!result.ok || typeof result.data.key !== 'string') return null;
    return normaliseEdition(result.data.key, result.data);
  }

  async lookupWork(workKey: string): Promise<WorkRow | null> {
    const key = olKey('works', 'W', workKey);
    if (!key) return null;
    const result = await this.client.getJson<Record<string, unknown>>(`${OL}${key}.json`);
    return result.ok ? normaliseWork(key, result.data) : null;
  }

  async lookupAuthor(authorKey: string): Promise<AuthorRow | null> {
    const key = olKey('authors', 'A', authorKey);
    if (!key) return null;
    const result = await this.client.getJson<Record<string, unknown>>(`${OL}${key}.json`);
    return result.ok ? normaliseAuthor(key, result.data) : null;
  }

  /** Same URL the app builds (apps/mobile/src/ui/tokens.ts). */
  coverUrl(coverId: number, size: CoverSize): string {
    return `${COVERS}/b/id/${coverId}-${size}.jpg`;
  }
}
