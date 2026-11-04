import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IMPORT_MAX_BYTES, formatBytes, pickedFileProblem, withoutBom } from '../importFile';

describe('a picked import file', () => {
  it('accepts a .csv or .txt export under 10 MB, whatever the case', () => {
    assert.equal(pickedFileProblem({ name: 'goodreads_library_export.csv', size: 120_000 }), null);
    assert.equal(pickedFileProblem({ name: 'Export.CSV', size: 10 }), null);
    assert.equal(pickedFileProblem({ name: 'library.txt' }), null);
    assert.equal(pickedFileProblem({ name: 'exactly.csv', size: IMPORT_MAX_BYTES }), null);
  });

  it('refuses another file type before reading it', () => {
    assert.match(pickedFileProblem({ name: 'library.xlsx', size: 10 }) ?? '', /\.csv file/);
    assert.match(pickedFileProblem({ name: 'photo.jpg' }) ?? '', /\.csv file/);
  });

  it('refuses a file over the server limit and says how big it is', () => {
    assert.equal(pickedFileProblem({ name: 'big.csv', size: IMPORT_MAX_BYTES + 1 }), 'This file is 10.0 MB. Imports can be up to 10 MB.');
    assert.match(pickedFileProblem({ name: 'big.csv', size: 25 * 1024 * 1024 }) ?? '', /25\.0 MB/);
  });

  it('drops a UTF-8 byte-order mark and nothing else', () => {
    assert.equal(withoutBom('﻿Title,Author'), 'Title,Author');
    assert.equal(withoutBom('Title,Author'), 'Title,Author');
    assert.equal(withoutBom(''), '');
  });

  it('formats sizes the way the file row shows them', () => {
    assert.equal(formatBytes(840), '840 B');
    assert.equal(formatBytes(12 * 1024), '12 KB');
    assert.equal(formatBytes(1.4 * 1024 * 1024), '1.4 MB');
  });
});
