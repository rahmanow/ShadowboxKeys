'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createJobs, redactAccessCode } = require('../lib/jobs');

const ESC = String.fromCharCode(27);
const CODE = '{"apiUrl":"https://203.0.113.9:41234/RealSecretPath","certSha256":"ABCD"}';

test('the access code never survives into what the browser can read', () => {
    // The installer prints it, the job log streams to the page, and the page
    // is not where a credential belongs - it has its own endpoint for that.
    const redacted = redactAccessCode('Done.\n' + CODE + '\nbye');
    assert.ok(!redacted.includes('RealSecretPath'), redacted);
    assert.match(redacted, /hidden/);
});

test('a job strips terminal colour and hides the code as output arrives', () => {
    const jobs = createJobs();
    const job = jobs.create();

    jobs.append(job, 'Starting Shadowbox ... OK\n');
    jobs.append(job, ESC + '[1;32m' + CODE + ESC + '[0m\n');

    const view = jobs.describe(job.id);
    assert.ok(!view.output.includes(ESC), 'an escape sequence reached the page');
    assert.ok(!view.output.includes('[1;32m'), 'a colour code reached the page');
    assert.ok(!view.output.includes('RealSecretPath'), 'the access code reached the page');
    assert.match(view.output, /Starting Shadowbox/);
});

test('what a job exposes never includes the SSH credential', () => {
    // Nothing puts it there, and this asserts that stays true: the whole job
    // is serialised to the browser on every poll.
    const jobs = createJobs();
    const job = jobs.create();
    const view = jobs.describe(job.id);

    assert.deepStrictEqual(
        Object.keys(view).sort(),
        ['error', 'finishedAt', 'hostKey', 'id', 'keys', 'output', 'serverId', 'startedAt', 'status', 'warning']
    );
});

test('the host-key question parks the job until it is answered', async () => {
    const jobs = createJobs();
    const job = jobs.create();

    const waiting = jobs.awaitHostKey(job, { hostPort: 'h:22', fingerprint: 'SHA256:x' });
    assert.strictEqual(jobs.describe(job.id).status, 'awaiting-host-key');
    assert.strictEqual(jobs.describe(job.id).hostKey.fingerprint, 'SHA256:x');

    jobs.answerHostKey(job.id, true);
    assert.strictEqual(await waiting, true);
    assert.strictEqual(jobs.describe(job.id).status, 'running');
    assert.strictEqual(jobs.describe(job.id).hostKey, null);
});

test('declining the host key resolves false rather than hanging', async () => {
    const jobs = createJobs();
    const job = jobs.create();
    const waiting = jobs.awaitHostKey(job, { hostPort: 'h:22', fingerprint: 'SHA256:x' });

    jobs.answerHostKey(job.id, false);
    assert.strictEqual(await waiting, false);
});

test('a failure releases a connection parked on the question', async () => {
    // Otherwise an abandoned run holds an SSH handshake open indefinitely.
    const jobs = createJobs();
    const job = jobs.create();
    const waiting = jobs.awaitHostKey(job, { hostPort: 'h:22', fingerprint: 'SHA256:x' });

    jobs.fail(job, new Error('gave up'));
    assert.strictEqual(await waiting, false);
    assert.strictEqual(jobs.describe(job.id).status, 'failed');
});

test('answering a job that is not waiting is refused, not ignored', () => {
    const jobs = createJobs();
    const job = jobs.create();
    assert.throws(() => jobs.answerHostKey(job.id, true), /not waiting/);
});

test('a server registered before a later failure is still reported', () => {
    // Keys can fail after the server exists. Calling that a failed run sends
    // somebody back to install a second copy on the same host.
    const jobs = createJobs();
    const job = jobs.create();

    jobs.registered(job, 'srv123');
    jobs.finish(job, { warning: 'keys failed' });

    const view = jobs.describe(job.id);
    assert.strictEqual(view.status, 'done');
    assert.strictEqual(view.serverId, 'srv123');
    assert.strictEqual(view.warning, 'keys failed');
});

test('an unknown job id is a clear refusal', () => {
    const jobs = createJobs();
    assert.throws(() => jobs.describe('nope'), /no longer around/);
});

test('a very long install log is trimmed from the front, keeping the end', () => {
    // The tail is where the failure is.
    const jobs = createJobs();
    const job = jobs.create();

    const padding = 'padding '.repeat(20);
    for (let i = 0; i < 12000; i++) jobs.append(job, 'line ' + i + ' ' + padding + '\n');
    jobs.append(job, 'THE LAST LINE\n');

    const output = jobs.describe(job.id).output;
    assert.ok(output.includes('THE LAST LINE'));
    assert.ok(output.includes('earlier output trimmed'));
    assert.ok(output.length < 300 * 1024, 'output should stay bounded');
});
