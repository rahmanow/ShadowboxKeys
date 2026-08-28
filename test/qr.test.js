'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { toSvgPath, MARGIN } = require('../lib/qr');

const ACCESS_URL = 'ss://YWVzOnBhc3N3b3Jk@vpn.example.com:443/?outline=1';

/** Replays the path commands back into a grid of dark modules. */
function decodePath(path, size) {
    const grid = Array.from({ length: size }, () => new Array(size).fill(false));
    for (const run of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
        const [x, y, width, back] = [Number(run[1]), Number(run[2]), Number(run[3]), Number(run[4])];
        assert.strictEqual(width, back, 'each run must close on itself');
        for (let i = 0; i < width; i++) grid[y][x + i] = true;
    }
    return grid;
}

test('the SVG path reproduces the encoder\'s module matrix exactly', () => {
    // A QR code that is off by one module is a QR code that does not scan, and
    // nothing else in this project would notice.
    const QRCode = require('qrcode-terminal/vendor/QRCode');
    const levels = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

    const { path, size } = toSvgPath(ACCESS_URL);
    const grid = decodePath(path, size);

    const qr = new QRCode(-1, levels.M);
    qr.addData(ACCESS_URL);
    qr.make();
    const count = qr.getModuleCount();

    assert.strictEqual(size, count + MARGIN * 2);
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            const inside = row >= MARGIN && col >= MARGIN && row < MARGIN + count && col < MARGIN + count;
            const expected = inside ? qr.isDark(row - MARGIN, col - MARGIN) : false;
            assert.strictEqual(grid[row][col], expected, `module ${row},${col}`);
        }
    }
});

test('the quiet zone is left blank on every side', () => {
    // Scanners need it; a code drawn flush to the edge reads unreliably.
    const { path, size } = toSvgPath(ACCESS_URL);
    const grid = decodePath(path, size);

    for (let i = 0; i < size; i++) {
        for (let m = 0; m < MARGIN; m++) {
            assert.strictEqual(grid[m][i], false, `top row ${m}`);
            assert.strictEqual(grid[size - 1 - m][i], false, `bottom row ${m}`);
            assert.strictEqual(grid[i][m], false, `left column ${m}`);
            assert.strictEqual(grid[i][size - 1 - m], false, `right column ${m}`);
        }
    }
});

test('the path carries no trace of the text it encodes', () => {
    // It is set as an attribute on an SVG element, so it must be pure geometry.
    const { path } = toSvgPath(ACCESS_URL);
    assert.match(path, /^[Mhvz0-9 -]+$/);
});

test('toSvgPath returns null rather than throwing on input it cannot encode', () => {
    assert.strictEqual(toSvgPath(''), null);
    assert.strictEqual(toSvgPath(null), null);
    // Far past the capacity of the largest QR version.
    assert.strictEqual(toSvgPath('x'.repeat(10000)), null);
});
