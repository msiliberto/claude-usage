#!/usr/bin/env bash
# Esegue il test dell'API ripulendo le variabili iniettate dagli snap
# (il terminale di VS Code snap imposta GIO_MODULE_DIR su moduli GIO
# incompatibili, che fanno fallire il backend TLS di libsoup).
cd "$(dirname "$0")/.." || exit 1
exec env -u GIO_MODULE_DIR -u LOCPATH -u GTK_PATH \
         -u GDK_PIXBUF_MODULE_FILE -u GDK_PIXBUF_MODULEDIR \
         -u GSETTINGS_SCHEMA_DIR \
    gjs -m tools/test-api.js "$@"
