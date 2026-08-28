'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseArgs, findKey } = require('../shadowtools');
const { OutlineClient, normalizeFingerprint } = require('../lib/outline');
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

const FINGERPRINT = 'e3823f9bb490d35487ee013ec7d23a3662f76b95eb01a40f4851905152f5a584';

test('normalizeFingerprint accepts the colon-separated form openssl prints', () => {
    const withColons = FINGERPRINT.toUpperCase().replace(/(..)(?=.)/g, '$1:');
    assert.strictEqual(normalizeFingerprint(withColons), FINGERPRINT);
});

test('normalizeFingerprint accepts the bare form Outline Manager reports', () => {
    assert.strictEqual(normalizeFingerprint(FINGERPRINT), FINGERPRINT);
    assert.strictEqual(normalizeFingerprint(FINGERPRINT.toUpperCase()), FINGERPRINT);
});

test('normalizeFingerprint treats an unset value as no pinning', () => {
    assert.strictEqual(normalizeFingerprint(''), null);
    assert.strictEqual(normalizeFingerprint(undefined), null);
});

test('normalizeFingerprint rejects anything that is not a SHA-256 digest', () => {
    const tooShort = FINGERPRINT.slice(0, 62);
    const notHex = 'z'.repeat(64);
    for (const bad of ['nonsense', tooShort, FINGERPRINT + 'ab', notHex]) {
        assert.throws(() => normalizeFingerprint(bad), UserError, `expected "${bad}" to be rejected`);
    }
});

test('the client rejects a bad fingerprint at construction, before any request', () => {
    assert.throws(() => new OutlineClient('https://1.2.3.4:16942/abc', 'nonsense'), UserError);
});

test('the client stores a normalised fingerprint, and none when unset', () => {
    const url = 'https://1.2.3.4:16942/abc';
    assert.strictEqual(new OutlineClient(url, FINGERPRINT.toUpperCase()).fingerprint, FINGERPRINT);
    assert.strictEqual(new OutlineClient(url).fingerprint, null);
});
