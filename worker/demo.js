'use strict';

/**
 * The data the preview runs on.
 *
 * Deliberately fictional, and deliberately not tidy: a key over its limit, one
 * with no name, one server with no domain and no pinned certificate, and one
 * that cannot be reached. Those are the states worth looking at while working
 * on the interface, and the ones a happy-path fixture never shows you.
 *
 * Addresses come from the ranges RFC 5737 and RFC 3849 reserve for
 * documentation, so nothing here points at a real host.
 */

const GB = 1024 ** 3;

const SERVERS = [
    {
        id: 'a1b2c3d4e5f6',
        name: 'Frankfurt',
        host: '198.51.100.14',
        domain: 'vpn.example.com',
        apiUrlPreview: 'https://198.51.100.14:16942/Fr4nkf…',
        certPinned: true,
        createdAt: '2026-03-02T09:14:00.000Z',
        source: 'file',
        editable: true,
        // Preview-only, stripped before the browser sees it.
        _reachable: true,
        _serverName: 'Frankfurt box',
        _serverLimitBytes: 100 * GB,
        _keys: [
            { id: '0', name: 'Alice', port: 443, dataLimitBytes: 10 * GB, bytes: 8.4 * GB },
            { id: '1', name: 'Bob', port: 444, dataLimitBytes: null, bytes: 41 * GB },
            { id: '2', name: 'Carol', port: 445, dataLimitBytes: 5 * GB, bytes: 5.2 * GB },
            { id: '3', name: '', port: 446, dataLimitBytes: null, bytes: 0.2 * GB },
            { id: '4', name: 'Dave (laptop)', port: 447, dataLimitBytes: 50 * GB, bytes: 12.9 * GB },
        ],
    },
    {
        id: 'b2c3d4e5f6a1',
        name: 'Singapore',
        host: '203.0.113.62',
        domain: '',
        apiUrlPreview: 'https://203.0.113.62:16942/S1ngap…',
        certPinned: false,
        createdAt: '2026-05-19T16:40:00.000Z',
        source: 'file',
        editable: true,
        _reachable: true,
        _serverName: 'Singapore box',
        _serverLimitBytes: null,
        _keys: [
            { id: '0', name: 'Erin', port: 500, dataLimitBytes: null, bytes: 2.1 * GB },
            { id: '1', name: 'Frank', port: 501, dataLimitBytes: 20 * GB, bytes: 0 },
        ],
    },
    {
        id: 'c3d4e5f6a1b2',
        name: 'Old Amsterdam',
        host: '198.51.100.201',
        domain: '',
        apiUrlPreview: 'https://198.51.100.201:16942/0ldAms…',
        certPinned: false,
        createdAt: '2025-11-08T11:02:00.000Z',
        source: 'file',
        editable: true,
        // The state you most need to be able to look at while designing.
        _reachable: false,
        _unreachableReason:
            'The server at 198.51.100.201:16942 did not respond within 15 seconds. Check that ' +
            'the address in the Management API URL is right and that its port is reachable from here.',
        _keys: [],
    },
];

/** A fresh copy, so one visitor's edits cannot leak into another's session. */
function freshState() {
    return {
        activeServerId: SERVERS[0].id,
        servers: JSON.parse(JSON.stringify(SERVERS)),
    };
}

/** An access URL for a key, in the same ss:// shape Outline hands out. */
function accessUrlFor(server, key) {
    const host = server.domain || server.host;
    // Not a usable credential: a fixed placeholder, base64 of "preview:preview".
    return `ss://cHJldmlldzpwcmV2aWV3@${host}:${key.port}/?outline=1`;
}

module.exports = { GB, freshState, accessUrlFor };
