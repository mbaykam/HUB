#!/usr/bin/env python3
"""Disposable loopback HTTPS/WSS cookie fixture; never accepts real credentials."""
import base64
import hashlib
import http.server
import json
import pathlib
import ssl
import struct
import subprocess
import sys


def headers_for(request):
    return {key: request.headers.get(key) for key in
            ("Origin", "Referer", "Sec-Fetch-Site", "Cookie")}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass  # No request/cookie logging, including synthetic values.

    def json_response(self, status, value, cookie=None):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        authenticated = "probe_session=synthetic-only" in (self.headers.get("Cookie") or "").split("; ")
        if self.path == "/seed":
            self.json_response(200, {"fixture": "seeded"},
                               "probe_session=synthetic-only; Path=/; Secure; HttpOnly; SameSite=Strict")
        elif self.path == "/expire":
            self.json_response(200, {"fixture": "expired"},
                               "probe_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0")
        elif self.path == "/api/inspect":
            self.json_response(200 if authenticated else 401,
                               {"fixture": "authenticated" if authenticated else "expired",
                                "headers": headers_for(self)})
        elif self.path == "/api/socket" and self.headers.get("Upgrade", "").lower() == "websocket":
            if not authenticated:
                self.json_response(401, {"fixture": "expired"})
                return
            key = self.headers.get("Sec-WebSocket-Key", "")
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            payload = json.dumps({"fixture": "authenticated-wss", "headers": headers_for(self)}).encode()
            prefix = bytes([0x81, len(payload)]) if len(payload) < 126 else bytes([0x81, 126]) + struct.pack("!H", len(payload))
            self.wfile.write(prefix + payload + b"\x88\x02\x03\xe8")
            self.wfile.flush()
            self.close_connection = True
        else:
            self.json_response(404, {"fixture": "unknown"})


def main():
    folder = pathlib.Path(sys.argv[1]).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    cert, key, der = (folder / name for name in ("certificate.pem", "key.pem", "certificate.der"))
    config = folder / "openssl.cnf"
    config.write_text("[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n"
                      "[dn]\nCN=127.0.0.1\n[extensions]\nsubjectAltName=IP:127.0.0.1\n"
                      "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
                      "extendedKeyUsage=serverAuth\n")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-keyout", str(key), "-out", str(cert), "-days", "1",
                    "-config", str(config)],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    key.chmod(0o600)
    subprocess.run(["openssl", "x509", "-in", str(cert), "-outform", "DER", "-out", str(der)], check=True)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    ready = folder / "ready.json"
    pending = folder / "ready.pending"
    pending.write_text(json.dumps({"origin": "https://127.0.0.1:" + str(server.server_port)}))
    pending.replace(ready)
    server.serve_forever()


if __name__ == "__main__":
    main()
