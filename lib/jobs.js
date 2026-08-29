'use strict';

const crypto = require('crypto');

const { UserError } = require('./errors');

/**
 * Long-running provisioning runs, tracked so the dashboard can watch one.
 *
 * Installing Outline takes minutes, which is far too long to hold a request
 * open across a connection that may itself be poor. So a run becomes a job the
 * page polls: progress survives a reload, a closed laptop, and a dropped
 * request, and the person watching can leave and come back.
 *
 * A job also gives the host-key question somewhere to live. The SSH handshake
 * has to stop and wait for an answer that arrives in a *different* HTTP
 * request, so the job holds the promise that the connection is blocked on.
 *
 * These live in memory only. A provisioning run does not outlive the process
 * doing it, so persisting them would only preserve records of runs that can no
 * longer be happening.
 */

const MAX_OUTPUT = 256 * 1024; // Enough for a full install log, bounded.
const KEEP_FINISHED_MS = 60 * 60 * 1000;

/**
 * Removes terminal colour codes, which the installer emits freely.
 *
 * They are meaningless in a browser and render as visible gibberish, which in
 * an install log reads like something went wrong.
 */
function stripAnsi(text) {
    // eslint-disable-next-line no-control-regex
    return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/** The access code appears in the installer's output; it must not ride along. */
function redactAccessCode(text) {
    return String(text).replace(
        /\{"apiUrl"\s*:\s*"[^"]+"\s*,\s*"certSha256"\s*:\s*"[^"]*"\}/g,
        '{"apiUrl":"…","certSha256":"…"}  [hidden — the server was saved]'
    );
}

function createJobs() {
    const jobs = new Map();

    /** Drops finished jobs after a while so a long-lived service does not grow. */
    function sweep() {
        const now = Date.now();
        for (const [id, job] of jobs) {
            if (job.finishedAt && now - job.finishedAt > KEEP_FINISHED_MS) jobs.delete(id);
        }
    }

    return {
        create() {
            sweep();
            const id = crypto.randomBytes(8).toString('hex');
            const job = {
                id,
                status: 'running',
                output: '',
                error: null,
                serverId: null,
                keys: [],
                warning: null,
                hostKey: null,       // { hostPort, fingerprint } while waiting
                startedAt: Date.now(),
                finishedAt: null,
                _resolveHostKey: null,
            };
            jobs.set(id, job);
            return job;
        },

        get(id) {
            const job = jobs.get(id);
            if (!job) throw new UserError('That provisioning run is no longer around.');
            return job;
        },

        /** What the browser is allowed to see: never the credential, never the code. */
        describe(id) {
            const job = this.get(id);
            return {
                id: job.id,
                status: job.status,
                output: job.output,
                error: job.error,
                serverId: job.serverId,
                keys: job.keys,
                warning: job.warning || null,
                hostKey: job.hostKey,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt,
            };
        },

        append(job, text) {
            const clean = redactAccessCode(stripAnsi(text));
            job.output += clean;
            // Keep the tail: the end of a failed install is the useful part.
            if (job.output.length > MAX_OUTPUT) {
                job.output = `[earlier output trimmed]\n${job.output.slice(-MAX_OUTPUT)}`;
            }
        },

        /**
         * Parks the job until someone answers the host-key question.
         * Resolves false if the job is abandoned, so the SSH connection dies
         * rather than hanging forever.
         */
        awaitHostKey(job, hostKey) {
            job.status = 'awaiting-host-key';
            job.hostKey = hostKey;
            return new Promise(resolve => {
                job._resolveHostKey = accepted => {
                    job.hostKey = null;
                    job._resolveHostKey = null;
                    // Only back to running if that is still where we are. A job
                    // failed while parked resolves this too, and must not have
                    // its verdict overwritten on the way out — that left the
                    // page polling a finished run forever.
                    if (job.status === 'awaiting-host-key') job.status = 'running';
                    resolve(accepted);
                };
            });
        },

        answerHostKey(id, accepted) {
            const job = this.get(id);
            if (!job._resolveHostKey) {
                throw new UserError('That run is not waiting on a host key.');
            }
            job._resolveHostKey(Boolean(accepted));
        },

        /** Records the server the moment it exists, before anything else can fail. */
        registered(job, serverId) {
            job.serverId = serverId;
        },

        finish(job, { serverId, keys, warning } = {}) {
            job.status = 'done';
            if (serverId) job.serverId = serverId;
            job.keys = keys || [];
            job.warning = warning || null;
            job.finishedAt = Date.now();
        },

        fail(job, error) {
            job.status = 'failed';
            job.error = error instanceof Error ? error.message : String(error);
            job.finishedAt = Date.now();
            // A connection blocked on the question must not stay blocked.
            if (job._resolveHostKey) job._resolveHostKey(false);
        },
    };
}

module.exports = { createJobs, redactAccessCode, MAX_OUTPUT };
