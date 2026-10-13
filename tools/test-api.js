#!/usr/bin/env -S gjs -m
/* Collaudo di rete + parsing + fuso orario SENZA riavviare GNOME Shell.
 *
 *   gjs -m tools/test-api.js [Europe/Rome]
 *
 * Usa gli stessi moduli dell'estensione, che non dipendono da St/Shell.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {CredentialsReader} from '../lib/credentials.js';
import {UsageClient} from '../lib/api.js';
import * as Fmt from '../lib/format.js';
import {limitLabel} from '../lib/i18n.js';

const tzId = ARGV[0] ?? 'Europe/Rome';
const tz = Fmt.resolveTimeZone(tzId);
const loop = new GLib.MainLoop(null, false);

function show(limit) {
    if (!limit) {
        print('  (assente)');
        return;
    }
    const bar = '#'.repeat(Math.round(limit.percent / 5)).padEnd(20, '.');
    print(`  ${limitLabel(limit).padEnd(22)} ${Fmt.formatPercent(limit.percent).padStart(5)}  [${bar}]`);
    print(`    reset ${Fmt.formatResetTime(limit.resetsAt, tz)}` +
          `  ·  tra ${Fmt.formatCountdown(limit.resetsAt)}` +
          `  ·  severity=${limit.severity}`);
}

const reader = new CredentialsReader();
print(`Fuso orario: ${tzId} (offset attuale ${GLib.DateTime.new_now(tz).format('%z')})`);
print(`Credenziali: ${reader.path}\n`);

reader.read(null, creds => {
    if (creds.error) {
        printerr(`Credenziali non leggibili: ${creds.error}`);
        loop.quit();
        return;
    }

    print(`Piano: ${creds.plan ?? 'sconosciuto'}`);
    print(`Token scaduto: ${creds.expired ? 'SÌ (apri Claude Code per rinnovarlo)' : 'no'}\n`);

    new UsageClient().fetch(creds.token, null, (err, data, retryAfter) => {
        if (err) {
            printerr(`Errore: ${err}` +
                (retryAfter ? ` (il server chiede di riprovare fra ${retryAfter}s)` : ''));
            loop.quit();
            return;
        }

        print('Sessione:');
        show(data.session);
        print('\nSettimanali:');
        if (data.weekly.length === 0)
            print('  (nessuno)');
        data.weekly.forEach(show);

        if (data.extraUsage)
            print(`\nCrediti extra attivi: ${Fmt.formatPercent(data.extraUsage.percent)}`);

        print(`\nPannello mostrerebbe: "${Fmt.formatPercent(data.session?.percent)} · ` +
              `${Fmt.formatCountdown(data.session?.resetsAt ?? null)}"`);
        loop.quit();
    });
});

loop.run();
