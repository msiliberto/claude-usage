/* Formattazione di orari, countdown e percentuali.
 *
 * L'API restituisce `resets_at` in UTC: la conversione al fuso configurato
 * (default Europe/Rome) va fatta esplicitamente, non lasciata al fuso di sistema.
 */

import GLib from 'gi://GLib';

import {dayName, dayUnit, monthName} from './i18n.js';

/** Risolve un identificatore IANA, con fallback al fuso di sistema. */
export function resolveTimeZone(id) {
    if (id) {
        const tz = GLib.TimeZone.new_identifier(id);
        if (tz)
            return tz;
    }
    return GLib.TimeZone.new_local();
}

/** ISO8601 (anche con microsecondi e offset) -> millisecondi epoch, o null. */
export function parseIso(iso) {
    if (!iso)
        return null;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
}

/** Due istanti (millisecondi epoch) cadono nello stesso giorno del fuso `tz`. */
export function isSameDay(a, b, tz) {
    const da = GLib.DateTime.new_from_unix_utc(Math.floor(a / 1000)).to_timezone(tz);
    const db = GLib.DateTime.new_from_unix_utc(Math.floor(b / 1000)).to_timezone(tz);

    return da.get_year() === db.get_year() &&
           da.get_day_of_year() === db.get_day_of_year();
}

/**
 * Ora del reset nel fuso `tz`. GLib applica da sé l'offset DST valido alla data
 * del reset (CET +01:00 / CEST +02:00), quindi il cambio d'ora non va gestito.
 * Se il reset non cade oggi si antepone il giorno.
 */
export function formatResetTime(ms, tz) {
    if (ms === null)
        return '—';

    const dt = GLib.DateTime.new_from_unix_utc(Math.floor(ms / 1000)).to_timezone(tz);

    if (isSameDay(ms, Date.now(), tz))
        return dt.format('%H:%M');
    // Nomi dalla lingua scelta, non dal locale di sistema.
    return `${dayName(dt.get_day_of_week())} ${dt.get_day_of_month()} ` +
        `${monthName(dt.get_month())}, ${dt.format('%H:%M')}`;
}

/**
 * Tempo mancante al reset. È una differenza fra istanti assoluti, quindi
 * indipendente dal fuso orario.
 */
export function formatCountdown(ms, now = Date.now()) {
    if (ms === null)
        return '—';

    const secs = Math.floor((ms - now) / 1000);
    if (secs <= 0)
        return '0m';

    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);

    if (h >= 24) {
        const d = Math.floor(h / 24);
        return `${d}${dayUnit()}${h % 24}h`;
    }
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}m`;
}

/** Percentuale arrotondata, con un decimale solo sotto l'1% per non mostrare "0%". */
export function formatPercent(percent) {
    if (percent === null || percent === undefined)
        return '—';
    if (percent > 0 && percent < 1)
        return '<1%';
    return `${Math.round(percent)}%`;
}

/** Ora locale (fuso `tz`) di un istante, per la riga "Aggiornato alle ...". */
export function formatClock(ms, tz) {
    if (!ms)
        return '—';
    return GLib.DateTime.new_from_unix_utc(Math.floor(ms / 1000))
        .to_timezone(tz)
        .format('%H:%M:%S');
}
