// Catalog-source port (PV-07): where book metadata comes from when our own
// catalog does not have it. Open Library is the only source, and the only one
// the licensing rule allows us to STORE (CC0; see catalog/gapfill.ts). A
// display-only source (Google Books) would be a second adapter whose results
// are never passed to persist().
//
// Every method returns an empty result instead of throwing: callers are on a
// user's request path, where "the source is down" means "carry on with what
// we have". Not-found and unavailable are therefore both null / [].
//
// Lookups return the same rows the dump ingest produces (catalog/ingest/
// normalise.ts): one parser for Open Library records, whichever door they
// come in by.

import type { AuthorRow, EditionRow, WorkRow } from '../../catalog/ingest/normalise.js';

export type { AuthorRow, EditionRow, WorkRow };

/** A search hit: less than a work record, and all gap-fill stores. */
export interface SearchWork {
  olWorkKey: string;
  title: string;
  firstPublishYear: number | null;
  coverId: number | null;
  authorKeys: string[];
  authorNames: string[];
  editionCount: number;
}

export type CoverSize = 'S' | 'M' | 'L';

export interface CatalogSource {
  search(query: string, limit: number): Promise<SearchWork[]>;
  /** ISBN-10 or -13, hyphens allowed. */
  lookupIsbn(isbn: string): Promise<EditionRow | null>;
  /** `/works/OL45804W` or `OL45804W`. */
  lookupWork(workKey: string): Promise<WorkRow | null>;
  /** `/authors/OL34184A` or `OL34184A`. */
  lookupAuthor(authorKey: string): Promise<AuthorRow | null>;
  coverUrl(coverId: number, size: CoverSize): string;
}

export { OpenLibrarySource, parseOlSearch } from './openlibrary.js';
