'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { page } = require('../lib/web');

/** Pulls the inline script out of the served page. */
function inlineScript(html) {
    const open = html.lastIndexOf('<script>');
    const close = html.lastIndexOf('</script>');
    assert.ok(open !== -1 && close > open, 'the page should carry an inline script');
    return html.slice(open + '<script>'.length, close);
}

test('the page it serves is syntactically valid JavaScript', () => {
    // The page is assembled inside a template literal, so an escape meant for
    // the browser can be eaten on the way out - a backslash-n intended as two
    // characters becomes a real newline and splits a string in half. That is a
    // blank dashboard and nothing else notices, because every test here talks
    // to the API rather than running the page.
    assert.doesNotThrow(() => new Function(inlineScript(page())));
});

test('the page carries the markup the script expects to find', () => {
    // render() reaches for these by id on every pass; a rename that missed one
    // would throw only once somebody opened the page.
    const html = page();
    for (const id of ['nav', 'switcher', 'title', 'crumb', 'view', 'error', 'refresh']) {
        assert.ok(html.includes('id="' + id + '"'), 'missing #' + id);
    }
});
