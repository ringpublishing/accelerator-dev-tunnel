import { inspectToken } from './token-info.js';

export interface CheckResult {
    ok: boolean;
    label: string;
    detail: string;
}

/** Renders a duration the way someone glancing at a terminal reads it. */
export function humanizeDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);

    if (seconds < 60) {
        return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) {
        return `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);

    if (hours < 24) {
        return `${hours}h${minutes % 60}m`;
    }

    return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** What the token says about itself. Not verified — only the proxy holds the secret. */
export function checkToken(token: string, vhost: string, variant: string): CheckResult {
    let info;

    try {
        info = inspectToken(token);
    } catch (err) {
        return { ok: false, label: 'token', detail: err instanceof Error ? err.message : String(err) };
    }

    if (info.expiresAt !== undefined && info.expiresAt <= Date.now()) {
        return {
            ok: false,
            label: 'token',
            detail: `expired ${humanizeDuration(Date.now() - info.expiresAt)} ago — reset it in the Accelerator panel`
        };
    }

    // A token pasted from the wrong variant authenticates and then serves nothing,
    // which is a long way to walk before finding out.
    if (info.vhost && info.variant && (info.vhost !== vhost || info.variant !== variant)) {
        return {
            ok: false,
            label: 'token',
            detail: `issued for ${info.vhost}::${info.variant}, not ${vhost}::${variant}`
        };
    }

    const validFor = info.expiresAt === undefined
        ? 'no expiry'
        : `valid for ${humanizeDuration(info.expiresAt - Date.now())}`;

    return { ok: true, label: 'token', detail: validFor };
}
