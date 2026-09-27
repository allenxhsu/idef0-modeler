// The per-element clocks: `updatedAt` and `deletedAt` on a box, an arrow, a
// diagram and a glossary concept. Three things are checked here — that the
// format stays additive (an unset clock is no member at all, and a file that
// never carried one round-trips byte for byte), that `clockInstant` reads
// exactly the ISO-8601 instants the rule says it does, and that the two rules
// report what the modeller has to fix. The same table of instants is in
// macos/Tests/IDEF0CoreTests/ClockTests.swift, so a reading that drifts in
// one app fails in the other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const J = await import(new URL('../../src/io/json.js', import.meta.url));
const V = await import(new URL('../../src/model/validate.js', import.meta.url));
const C = await import(new URL('../../src/model/concepts.js', import.meta.url));
const M = await import(new URL('../../src/model/model.js', import.meta.url));

const FIXTURES = new URL('../../macos/Tests/IDEF0CoreTests/Fixtures/', import.meta.url);
const sampleText = readFileSync(new URL('sample.idef0.json', FIXTURES), 'utf8');
const load = () => J.deserialize(sampleText);

/** The sample with a clock on one of everything. */
function clocked() {
  const m = load();
  const dgs = Object.values(m.diagrams);
  dgs[1].updatedAt = '2026-09-25T11:30:00.500+02:00';
  dgs[1].boxes[0].updatedAt = '2026-09-26T09:15:00Z';
  dgs[1].boxes[1].deletedAt = '2026-09-26T10:00:00Z';
  dgs[1].arrows[0].updatedAt = '2026-09-26T09:20:00Z';
  m.glossary[0].updatedAt = '2026-09-24T08:00:00Z';
  return m;
}

/* ------------------------------------------------------------- the format */

test('a file written without clocks round-trips byte for byte', () => {
  assert.equal(J.serialize(J.deserialize(sampleText)), sampleText);
});

test('a file written with clocks round-trips byte for byte', () => {
  const text = J.serialize(clocked());
  assert.equal(J.serialize(J.deserialize(text)), text);
  assert.equal((text.match(/"(?:updatedAt|deletedAt)":/g) || []).length, 5);
});

test('an absent, null or empty clock writes no member at all', () => {
  const m = load();
  const dg = Object.values(m.diagrams)[1];
  dg.updatedAt = '';
  dg.deletedAt = null;
  dg.boxes[0].updatedAt = '';
  dg.arrows[0].deletedAt = null;
  m.glossary[0].updatedAt = '';
  assert.equal(J.serialize(m), sampleText);
});

test('a clock is written after everything else the element models, before its extras', () => {
  const m = load();
  const box = Object.values(m.diagrams)[1].boxes[0];
  box.iri = 'urn:example:box';
  box.updatedAt = '2026-09-26T09:15:00Z';
  const written = JSON.stringify(JSON.parse(J.serialize(m)).diagrams[Object.keys(m.diagrams)[1]].boxes[0]);
  assert.deepEqual(Object.keys(JSON.parse(written)).slice(-3), ['refs', 'updatedAt', 'iri']);
});

test('a clock is never invented for an element that has none', () => {
  const m = M.createModel('Fresh');
  const box = M.contextDiagram(m).boxes[0];
  assert.equal(box.updatedAt, undefined);
  assert.equal(box.deletedAt, undefined);
  assert.ok(!J.serialize(m).includes('updatedAt'));
});

// The XML interchange carries a clock as an attribute of <diagram>,
// <activity>, <arrow> and <term>; `fromXml` needs a DOMParser, which plain
// Node has not, so that round trip is checked by XMLInterchangeParityTests
// over every scenario — the clock ones included.

/* ------------------------------------------------ reading an ISO-8601 instant */

// [text, instant] — the same table as ClockTests.swift.
const ACCEPTED = [
  ['1970-01-01T00:00:00Z', 0],
  ['2026-09-27T14:05:00Z', 1790517900000],
  ['2026-09-27T14:05:00.5Z', 1790517900500],
  ['2026-09-27T14:05:00.123456Z', 1790517900123],
  ['2026-09-27T16:05:00+02:00', 1790517900000],
  ['2026-09-27T12:05:00-02:00', 1790517900000],
  ['2026-09-27T14:05:00+00:00', 1790517900000],
  ['2024-02-29T00:00:00Z', 1709164800000],
  ['1900-03-01T00:00:00Z', -2203891200000],
  ['0000-01-01T00:00:00Z', -62167219200000],
];

const REJECTED = [
  '', 'yesterday',
  '2026-09-27T14:05:00',        // no zone at all
  '2026-09-27 14:05:00Z',       // a space where the T belongs
  '2026-09-27t14:05:00Z',       // a lowercase designator
  '2026-09-27T14:05:00z',
  '2026-02-30T00:00:00Z',       // a day February never has
  '1900-02-29T00:00:00Z',       // 1900 is no leap year
  '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z',
  '2026-09-27T24:00:00Z', '2026-09-27T14:60:00Z', '2026-09-27T14:05:60Z',
  '2026-09-27T14:05:00.Z',      // a fraction with no digits
  '2026-09-27T14:05:00+0200',   // no colon in the offset
  '2026-09-27T14:05:00+24:00',
  '2026-09-27T14:05:00Z ', '2026-09-27T14:05:00Zx',
  '2026-9-27T14:05:00Z',        // no padding
];

test('clockInstant reads exactly the ISO-8601 instants the rule allows', () => {
  for (const [text, instant] of ACCEPTED) assert.equal(V.clockInstant(text), instant, text);
  for (const text of REJECTED) assert.equal(V.clockInstant(text), null, text);
});

/* -------------------------------------------------------------- the rules */

const codes = (m) => V.validate(m).filter((i) => i.code.startsWith('provenance'));

test('a valid clock on any element is reported as nothing at all', () => {
  assert.deepEqual(codes(C.bindAll(clocked())), []);
});

test('provenance-date names the element, the field and what to write instead', () => {
  const m = C.bindAll(load());
  const dg = Object.values(m.diagrams)[1];
  dg.boxes[0].updatedAt = 'yesterday';
  const found = codes(m);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.equal(found[0].code, 'provenance-date');
  assert.equal(found[0].message,
    'A1: updatedAt reads “yesterday”, which is not an ISO-8601 instant. Write it as 2026-09-27T14:05:00Z, or clear it.');
  assert.equal(found[0].kind, 'box');
  assert.equal(found[0].id, dg.boxes[0].id);
});

test('provenance-order catches a tombstone earlier than the change it ends, across zones', () => {
  const m = C.bindAll(load());
  const arrow = Object.values(m.diagrams)[1].arrows[0];
  arrow.updatedAt = '2026-09-26T12:00:00+02:00';
  arrow.deletedAt = '2026-09-26T09:59:00Z';
  const found = codes(m);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.equal(found[0].code, 'provenance-order');
  assert.match(found[0].message, /^“Customer Order” on A0: deletedAt \(2026-09-26T09:59:00Z\) is earlier than updatedAt \(2026-09-26T12:00:00\+02:00\)\./);
  // The same two instants the other way round are in order and say nothing.
  arrow.updatedAt = '2026-09-26T09:59:00Z';
  arrow.deletedAt = '2026-09-26T12:00:00+02:00';
  assert.deepEqual(codes(m), []);
});

test('an unreadable clock is not also ordered, and each field is reported once', () => {
  const m = C.bindAll(load());
  const arrow = Object.values(m.diagrams)[1].arrows[0];
  arrow.updatedAt = 'yesterday';
  arrow.deletedAt = '1999-01-01T00:00:00Z';
  const found = codes(m);
  assert.deepEqual(found.map((i) => i.code), ['provenance-date']);
});

test('every kind of element is checked: diagram, box, arrow and concept', () => {
  const m = C.bindAll(load());
  const dg = Object.values(m.diagrams)[1];
  dg.updatedAt = 'no';
  dg.boxes[0].updatedAt = 'no';
  dg.arrows[0].updatedAt = 'no';
  m.glossary[0].updatedAt = 'no';
  const found = codes(m);
  assert.equal(found.length, 4);
  assert.deepEqual(found.map((i) => i.kind), [null, 'box', 'arrow', 'box']);
  assert.ok(found[3].message.startsWith(`“${m.glossary[0].term}”: updatedAt reads`));
});
