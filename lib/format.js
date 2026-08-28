'use strict';

const { UserError } = require('./errors');

const UNITS = [
    { suffix: 'TB', bytes: 1024 ** 4 },
    { suffix: 'GB', bytes: 1024 ** 3 },
    { suffix: 'MB', bytes: 1024 ** 2 },
    { suffix: 'KB', bytes: 1024 },
];

/** Renders a byte count as a short human-readable string, e.g. 1536 -> "1.5 KB". */
function formatBytes(bytes) {
    if (!bytes) return '0 B';
    for (const unit of UNITS) {
        if (bytes >= unit.bytes) {
            const value = bytes / unit.bytes;
            return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit.suffix}`;
        }
    }
    return `${bytes} B`;
}

/**
 * Parses a human-written size such as "10GB", "500 MB" or "1073741824" into bytes.
 * Throws if the input cannot be understood.
 */
function parseBytes(input) {
    const match = String(input).trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
    if (!match) {
        throw new UserError(`Could not understand the size "${input}". Try something like 10GB or 500MB.`);
    }
    const value = parseFloat(match[1]);
    const suffix = (match[2] || 'B').toUpperCase();
    const unit = UNITS.find(u => u.suffix === suffix);
    return Math.round(value * (unit ? unit.bytes : 1));
}

/** Rewrites the host in an ss:// access URL, leaving port, query and fragment intact. */
function rewriteAccessUrl(accessUrl, fromHost, toHost) {
    if (!accessUrl || fromHost === toHost) return accessUrl;
    return accessUrl.replace('@' + fromHost + ':', '@' + toHost + ':');
}

/** Prints an array of row objects as an aligned text table. */
function printTable(columns, rows) {
    if (rows.length === 0) {
        console.log('(none)');
        return;
    }
    const widths = columns.map(col =>
        Math.max(col.header.length, ...rows.map(row => String(row[col.key] ?? '').length))
    );
    const line = cells =>
        cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ').trimEnd();

    console.log(line(columns.map(col => col.header)));
    console.log(line(widths.map(width => '-'.repeat(width))));
    for (const row of rows) {
        console.log(line(columns.map(col => row[col.key])));
    }
}

/** Prints rows as CSV, quoting fields that need it. */
function printCsv(columns, rows) {
    const escape = value => {
        const text = String(value ?? '');
        return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    console.log(columns.map(col => escape(col.header)).join(','));
    for (const row of rows) {
        console.log(columns.map(col => escape(row[col.key])).join(','));
    }
}

module.exports = { formatBytes, parseBytes, rewriteAccessUrl, printTable, printCsv };
