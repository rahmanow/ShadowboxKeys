'use strict';

/**
 * QR codes for the dashboard.
 *
 * The CLI prints block-character codes, which scan fine in a terminal but look
 * like 9px mush in a browser. The dashboard is where people actually hand a key
 * to someone, so it gets a vector code instead: crisp at any size, legible on a
 * projector, and clean in a screenshot.
 *
 * Rather than take on a second QR dependency, this reuses the encoder already
 * vendored inside qrcode-terminal. That is an internal path, so the require is
 * guarded — if a future version moves it, the dashboard quietly falls back to
 * the block-character code, which is exactly what it rendered before.
 *
 * What crosses the wire is a path string built solely from the module matrix.
 * No part of the access URL appears in the markup, so nothing here can be
 * turned into an injection point by a hostile key name or host.
 */

let encoder = null;
try {
    // eslint-disable-next-line global-require
    const QRCode = require('qrcode-terminal/vendor/QRCode');
    const levels = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
    encoder = { QRCode, levels };
} catch (err) {
    encoder = null;
}

const MARGIN = 4; // The quiet zone the spec requires, in modules.

/**
 * Encodes text as an SVG path over a unit-per-module grid.
 *
 * Level M is a deliberate step up from the CLI's L: an access URL scanned off a
 * screen at an angle has less margin for error than one scanned off a terminal.
 *
 * @returns {{path: string, size: number}|null} null when the encoder is absent.
 */
function toSvgPath(text) {
    if (!encoder || !text) return null;

    let qr;
    try {
        qr = new encoder.QRCode(-1, encoder.levels.M);
        qr.addData(String(text));
        qr.make();
    } catch (err) {
        // Text too long for any version, or an encoder we no longer understand.
        return null;
    }

    const count = qr.getModuleCount();
    const parts = [];

    // Merge each row's dark modules into runs, so the path is a few hundred
    // commands rather than one per module.
    for (let row = 0; row < count; row++) {
        let start = -1;
        for (let col = 0; col <= count; col++) {
            const dark = col < count && qr.isDark(row, col);
            if (dark && start === -1) start = col;
            if (!dark && start !== -1) {
                parts.push(`M${start + MARGIN} ${row + MARGIN}h${col - start}v1h-${col - start}z`);
                start = -1;
            }
        }
    }

    return { path: parts.join(''), size: count + MARGIN * 2 };
}

module.exports = { toSvgPath, MARGIN };
