'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseArgs, findKey } = require('../shadowboxKey');
const { UserError } = require('../lib/errors');

test('parseArgs separates positional arguments from flags', () => {
    const { positional, flags } = parseArgs(['add', 'Alice', '--qr']);
    assert.deepStrictEqual(positional, ['add', 'Alice']);
    assert.deepStrictEqual(flags, { qr: true });
});

test('parseArgs reads the value that follows --limit', () => {
    const { positional, flags } = parseArgs(['add', 'Alice', '--limit', '50GB']);
    assert.deepStrictEqual(positional, ['add', 'Alice']);
    assert.strictEqual(flags.limit, '50GB');
});

test('parseArgs recognises both spellings of help', () => {
    assert.strictEqual(parseArgs(['-h']).flags.help, true);
    assert.strictEqual(parseArgs(['--help']).flags.help, true);
});

test('parseArgs keeps multi-word names as separate positional arguments', () => {
    assert.deepStrictEqual(parseArgs(['rename', '0', 'Carol', 'Smith']).positional,
        ['rename', '0', 'Carol', 'Smith']);
});

const KEYS = [
    { id: '0', name: 'Alice' },
    { id: '1', name: 'Bob' },
    { id: '2', name: 'bob' },
    { id: '3', name: '' },
];

test('findKey matches on id', () => {
    assert.strictEqual(findKey(KEYS, '0').name, 'Alice');
    assert.strictEqual(findKey(KEYS, '3').id, '3');
});

test('findKey matches on exact name', () => {
    assert.strictEqual(findKey(KEYS, 'Alice').id, '0');
});

test('findKey prefers an exact name over a case-insensitive one', () => {
    // Both "Bob" and "bob" exist, so an exact match must win rather than being ambiguous.
    assert.strictEqual(findKey(KEYS, 'Bob').id, '1');
    assert.strictEqual(findKey(KEYS, 'bob').id, '2');
});

test('findKey falls back to a case-insensitive name match', () => {
    assert.strictEqual(findKey(KEYS, 'ALICE').id, '0');
});

test('findKey prefers an id over a name that looks like one', () => {
    const keys = [{ id: '0', name: '1' }, { id: '1', name: 'Bob' }];
    assert.strictEqual(findKey(keys, '1').name, 'Bob');
});

test('findKey reports when nothing matches', () => {
    assert.throws(() => findKey(KEYS, 'Nobody'), UserError);
});

test('findKey refuses to guess between duplicate names', () => {
    const keys = [{ id: '0', name: 'Alice' }, { id: '1', name: 'Alice' }];
    assert.throws(() => findKey(keys, 'Alice'), /matches more than one key/);
});
