'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { formatBytes, parseBytes, rewriteAccessUrl, printTable, printCsv } = require('../lib/format');
const { UserError } = require('../lib/errors');

const KB = 1024;
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const TB = 1024 ** 4;

test('formatBytes renders each unit', () => {
    assert.strictEqual(formatBytes(0), '0 B');
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(1.5 * KB), '1.5 KB');
    assert.strictEqual(formatBytes(512 * MB), '512 MB');
    assert.strictEqual(formatBytes(3 * GB), '3.0 GB');
    assert.strictEqual(formatBytes(2 * TB), '2.0 TB');
});

test('formatBytes drops decimals once the value reaches 10', () => {
    assert.strictEqual(formatBytes(9.5 * GB), '9.5 GB');
    assert.strictEqual(formatBytes(10 * GB), '10 GB');
});

test('formatBytes treats missing values as zero', () => {
    assert.strictEqual(formatBytes(undefined), '0 B');
    assert.strictEqual(formatBytes(null), '0 B');
});

test('parseBytes understands unit suffixes, spacing and case', () => {
    assert.strictEqual(parseBytes('10GB'), 10 * GB);
    assert.strictEqual(parseBytes('500 MB'), 500 * MB);
    assert.strictEqual(parseBytes('2tb'), 2 * TB);
    assert.strictEqual(parseBytes('1.5GB'), 1.5 * GB);
    assert.strictEqual(parseBytes(' 4 kb '), 4 * KB);
});

test('parseBytes accepts a plain byte count', () => {
    assert.strictEqual(parseBytes('1024'), 1024);
    assert.strictEqual(parseBytes('900B'), 900);
});

test('parseBytes rejects input it cannot understand', () => {
    for (const bad of ['10QQ', 'lots', '', 'GB', '1.2.3GB', '-5GB']) {
        assert.throws(() => parseBytes(bad), UserError, `expected "${bad}" to be rejected`);
    }
});

test('parseBytes and formatBytes round-trip', () => {
    for (const size of ['10GB', '500MB', '2TB', '750KB']) {
        assert.strictEqual(formatBytes(parseBytes(size)).replace(/\.0 | /, ''), size);
    }
});

test('rewriteAccessUrl swaps the host and keeps port, query and fragment', () => {
    assert.strictEqual(
        rewriteAccessUrl('ss://abc@1.2.3.4:443/?outline=1', '1.2.3.4', 'vpn.example.com'),
        'ss://abc@vpn.example.com:443/?outline=1'
    );
    assert.strictEqual(
        rewriteAccessUrl('ss://abc@1.2.3.4:8388/?outline=1#Alice', '1.2.3.4', 'vpn.example.com'),
        'ss://abc@vpn.example.com:8388/?outline=1#Alice'
    );
});

test('rewriteAccessUrl leaves the URL alone when there is nothing to change', () => {
    const url = 'ss://abc@1.2.3.4:443/?outline=1';
    assert.strictEqual(rewriteAccessUrl(url, '1.2.3.4', '1.2.3.4'), url);
    assert.strictEqual(rewriteAccessUrl(undefined, '1.2.3.4', 'vpn.example.com'), undefined);
});

test('rewriteAccessUrl does not touch a host appearing elsewhere in the URL', () => {
    // The host also appears in the base64 payload; only the @host: occurrence should change.
    assert.strictEqual(
        rewriteAccessUrl('ss://MS4yLjMuNA@1.2.3.4:443/?outline=1', '1.2.3.4', 'example.com'),
        'ss://MS4yLjMuNA@example.com:443/?outline=1'
    );
});

/** Runs fn with console.log captured, returning the lines it printed. */
function captureOutput(fn) {
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
        fn();
    } finally {
        console.log = original;
    }
    return lines;
}

const COLUMNS = [
    { key: 'id', header: 'ID' },
    { key: 'name', header: 'NAME' },
];

test('printTable aligns columns and underlines the header', () => {
    const lines = captureOutput(() =>
        printTable(COLUMNS, [{ id: '0', name: 'Alice' }, { id: '10', name: 'Bo' }])
    );
    assert.deepStrictEqual(lines, [
        'ID  NAME',
        '--  -----',
        '0   Alice',
        '10  Bo',
    ]);
});

test('printTable says so when there is nothing to show', () => {
    assert.deepStrictEqual(captureOutput(() => printTable(COLUMNS, [])), ['(none)']);
});

test('printCsv quotes fields containing commas, quotes or newlines', () => {
    const lines = captureOutput(() =>
        printCsv(COLUMNS, [
            { id: '0', name: 'Smith, Alice' },
            { id: '1', name: 'He said "hi"' },
            { id: '2', name: 'two\nlines' },
            { id: '3', name: undefined },
        ])
    );
    assert.deepStrictEqual(lines, [
        'ID,NAME',
        '0,"Smith, Alice"',
        '1,"He said ""hi"""',
        '2,"two\nlines"',
        '3,',
    ]);
});
