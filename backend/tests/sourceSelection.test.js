import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getAvailableDataSources,
  getDataSourceConfig,
  getItemByAliasId,
  getSubclassCandidates
} from '../data/excelAdapter.js';

test('available data sources includes Teamcenter 1 and Teamcenter 2', () => {
  const sources = getAvailableDataSources();

  assert.ok(sources.some((source) => source.id === 'teamcenter1'));
  assert.ok(sources.some((source) => source.id === 'teamcenter2'));
  assert.ok(sources.some((source) => source.id === 'outsource'));
});

test('source config returns the expected Teamcenter 1 setup', () => {
  const source = getDataSourceConfig('teamcenter1');

  assert.equal(source.label, 'Teamcenter 1');
  assert.equal(source.type, 'excel');
  assert.ok(source.filePath.includes('teamcenter1'));
});

test('reads SubItem as the subclass from the selected workbook', () => {
  const item = getItemByAliasId('5745122-2', 'teamcenter1');
  const candidates = getSubclassCandidates(item, 'teamcenter1');

  assert.equal(item.subclass, 'Socket');
  assert.ok(candidates.includes('Socket'));
});
