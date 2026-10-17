#!/usr/bin/env python3
"""qbit-booster-mediainfo : petit service HTTP qui renvoie la sortie texte de `mediainfo` pour un fichier.

GET /mediainfo?path=/media/...   -> 200 text/plain (sortie mediainfo)
GET /health                      -> 200 "ok"

Seuls les fichiers situés sous ALLOWED_ROOT (après résolution des liens symboliques et des
"..") sont acceptés.
"""
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ALLOWED_ROOT = os.path.realpath(os.environ.get("ALLOWED_ROOT", "/media"))
PORT = int(os.environ.get("PORT", "8765"))
TIMEOUT = int(os.environ.get("MEDIAINFO_TIMEOUT", "60"))


def is_allowed(real_path: str) -> bool:
    return real_path == ALLOWED_ROOT or real_path.startswith(ALLOWED_ROOT.rstrip(os.sep) + os.sep)


class Handler(BaseHTTPRequestHandler):
    server_version = "qbit-booster-mediainfo"

    def _send(self, code: int, text: str) -> None:
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        url = urlparse(self.path)
        if url.path == "/health":
            return self._send(200, "ok")
        if url.path != "/mediainfo":
            return self._send(404, "Route inconnue")

        raw = parse_qs(url.query).get("path", [""])[0]
        if not raw:
            return self._send(400, "Paramètre 'path' manquant")
        real = os.path.realpath(raw)
        if not is_allowed(real):
            return self._send(403, f"Chemin hors de ALLOWED_ROOT ({ALLOWED_ROOT})")
        if not os.path.isfile(real):
            return self._send(404, f"Fichier introuvable : {raw}")

        try:
            res = subprocess.run(["mediainfo", real], capture_output=True, text=True, timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            return self._send(504, f"mediainfo a dépassé {TIMEOUT} s")
        except OSError as e:
            return self._send(500, f"Impossible d'exécuter mediainfo : {e}")
        if res.returncode != 0:
            return self._send(500, res.stderr.strip() or "Échec de mediainfo")
        self._send(200, res.stdout)


if __name__ == "__main__":
    print(f"qbit-booster-mediainfo : port {PORT}, ALLOWED_ROOT={ALLOWED_ROOT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
