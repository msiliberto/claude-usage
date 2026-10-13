/* Chiamata a https://api.anthropic.com/api/oauth/usage e normalizzazione
 * della risposta in un modello stabile.
 *
 * È lo stesso endpoint che alimenta `/usage` dentro Claude Code, quindi i
 * numeri coincidono con quelli mostrati dalla CLI.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {parseIso} from './format.js';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

/* Codici HTTP come numeri e non come Soup.Status: vedi `interpret()`. */
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;

/** Limiti settimanali noti; gli altri ricadono su 'weekly'. Le etichette,
 * nella lingua scelta, le dà lib/i18n.js: qui si salva solo il tipo, perché il
 * dato finisce in cache e la lingua può cambiare dopo. */
const WEEKLY_KINDS = new Set(['weekly_all', 'weekly_opus', 'weekly_sonnet']);

export class UsageClient {
    constructor() {
        this._session = new Soup.Session({timeout: 15});
    }

    /**
     * Scarica l'utilizzo. Il callback riceve (error, data, retryAfter) dove
     * `error` è null, 'auth' (token scaduto/revocato), 'rate-limit' (429),
     * 'network' o 'parse', e `retryAfter` sono i secondi chiesti dal server
     * sul 429 (0 se non li ha detti). Non viene chiamato se la richiesta è
     * stata annullata, ed è garantito che venga chiamato esattamente una
     * volta negli altri casi.
     */
    fetch(token, cancellable, callback) {
        const msg = Soup.Message.new('GET', USAGE_URL);
        const headers = msg.get_request_headers();
        headers.append('Authorization', `Bearer ${token}`);
        headers.append('anthropic-beta', OAUTH_BETA);
        headers.append('Accept', 'application/json');

        this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                let bytes;
                try {
                    bytes = session.send_and_read_finish(res);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    callback('network', null, 0);
                    return;
                }

                /* Chi chiama azzera il proprio flag "richiesta in corso" solo
                 * dentro il callback: un'eccezione che sfuggisse di qui lo
                 * lascerebbe alzato per sempre, e l'indicatore resterebbe a "…"
                 * senza più riprovare fino al riavvio della shell. */
                let outcome;
                try {
                    outcome = interpret(msg, bytes);
                } catch (e) {
                    logError(e, 'claude-usage: risposta inattesa');
                    outcome = ['parse', null, 0];
                }
                callback(...outcome);
            });
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }
}

/**
 * Quanto aspettare prima di ripresentarsi, secondo il server.
 *
 * `Retry-After` ammette due forme: un numero di secondi o una data HTTP.
 * Restituisce 0 quando l'intestazione manca o non si lascia leggere: in quel
 * caso decide il backoff di chi chiama.
 */
function retryAfterSeconds(msg) {
    const value = msg.get_response_headers().get_one('Retry-After');
    if (!value)
        return 0;

    const seconds = Number(value.trim());
    if (Number.isFinite(seconds))
        return Math.max(0, Math.round(seconds));

    const date = Date.parse(value);
    return Number.isNaN(date) ? 0 : Math.max(0, Math.round((date - Date.now()) / 1000));
}

/**
 * Traduce la risposta in `[error, data, retryAfter]`.
 *
 * Lo stato si legge dalla property `status-code`, un uint, e non da
 * `get_status()`: quello converte in `Soup.Status` e GJS solleva
 * «429 is not a valid value for enumeration Status» sui codici che l'enum non
 * elenca. Proprio 429 è quello che l'API restituisce quando limita le
 * richieste, quindi il caso non è affatto teorico.
 */
function interpret(msg, bytes) {
    const status = msg.status_code;

    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN)
        return ['auth', null, 0];
    if (status === HTTP_TOO_MANY_REQUESTS)
        return ['rate-limit', null, retryAfterSeconds(msg)];
    if (status !== HTTP_OK)
        return ['network', null, 0];

    try {
        const raw = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        return [null, normalize(raw), 0];
    } catch {
        return ['parse', null, 0];
    }
}

function makeLimit(kind, percent, resetsAt, severity) {
    if (percent === null || percent === undefined)
        return null;
    return {
        kind,
        percent: Number(percent),
        resetsAt: parseIso(resetsAt),
        severity: severity ?? 'normal',
    };
}

/**
 * Preferisce l'array `limits[]` (forma più recente e già uniforme) e ricade sui
 * campi storici `five_hour` / `seven_day*` se assente.
 */
export function normalize(raw) {
    const limits = Array.isArray(raw?.limits) ? raw.limits : [];

    let session = null;
    const entry = limits.find(l => l.kind === 'session' || l.group === 'session');
    if (entry)
        session = makeLimit('session', entry.percent, entry.resets_at, entry.severity);
    if (!session && raw?.five_hour) {
        session = makeLimit('session', raw.five_hour.utilization,
            raw.five_hour.resets_at, null);
    }

    let weekly = limits
        .filter(l => l.group === 'weekly')
        .map(l => makeLimit(WEEKLY_KINDS.has(l.kind) ? l.kind : 'weekly', l.percent,
            l.resets_at, l.severity))
        .filter(l => l !== null);

    if (weekly.length === 0) {
        weekly = [
            ['seven_day', 'weekly_all'],
            ['seven_day_opus', 'weekly_opus'],
            ['seven_day_sonnet', 'weekly_sonnet'],
        ]
            .map(([key, kind]) => raw?.[key]
                ? makeLimit(kind, raw[key].utilization, raw[key].resets_at, null)
                : null)
            .filter(l => l !== null);
    }

    const extra = raw?.extra_usage;
    return {
        session,
        weekly,
        extraUsage: extra?.is_enabled
            ? {percent: raw?.spend?.percent ?? extra.utilization ?? 0}
            : null,
    };
}
