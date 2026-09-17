import type { ResponseInfo } from './types.js';

/** Timestamps in the log, in the one format that sorts and reads the same everywhere. */
export function formatTimestamp(date: Date = new Date()): string {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * One request, as it appears in a terminal.
 *
 * Shared by the CLI and both bundler plugins: they are three windows onto the same
 * tunnel, and a developer who moves between them should not have to read three
 * different formats. A status of zero means the connection ended before an answer
 * arrived, which is worth saying rather than leaving the line off entirely.
 */
export function formatRequestLine(info: ResponseInfo): string {
    const outcome = info.statusCode === 0
        ? 'no response'
        : `${info.statusCode} ${info.durationMs}ms`;

    return `${formatTimestamp()} ${info.method} ${info.path} → ${outcome} ${info.remoteIp}`;
}
