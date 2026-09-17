/**
 * The wire contract with the dev-tunnel proxy.
 *
 * These shapes are agreed with the proxy and changing one is a protocol change; see
 * docs/protocol.md, which describes the same messages from both sides.
 */

export interface AuthMessage {
    type: 'auth';
    token: string;
}

export interface AuthOkMessage {
    type: 'auth_ok';
}

export interface AuthErrorMessage {
    type: 'auth_error';
    reason: string;
}

export interface ShutdownMessage {
    type: 'shutdown';
}

export interface OpenDataMessage {
    type: 'open_data';
    requestId: string;
    method: string;
    path: string;
    remoteIp: string;
    isWebSocket?: boolean;
    /**
     * Browser handshake headers, for a WebSocket passthrough.
     *
     * Without them the local handshake can only be rebuilt from the path, which drops
     * the negotiated subprotocol, Origin, cookies and Authorization — and Vite HMR
     * negotiates a subprotocol.
     */
    headers?: Record<string, string>;
}

export type ControlMessage = AuthOkMessage | AuthErrorMessage | ShutdownMessage | OpenDataMessage;

// ── Internal resolved config ─────────────────────────────────────────
