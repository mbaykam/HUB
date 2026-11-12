"""Loopback protocol smoke only: does not stand in for TLS or WebKit checks."""
import http.client
import http.server
import json
import socket
import struct
import threading
import unittest

from transport import Handler


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)

    def tearDown(self):
        self.connection.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def request(self, path, headers=None):
        self.connection.request("GET", path, headers=headers or {})
        response = self.connection.getresponse()
        body = json.loads(response.read())
        self.assertEqual(response.getheader("Content-Type"), "application/json")
        return response, body

    def test_cookie_contract_and_expired_json(self):
        response, body = self.request("/seed")
        self.assertEqual(body["fixture"], "seeded")
        self.assertEqual(response.getheader("Set-Cookie"),
                         "probe_session=synthetic-only; Path=/; Secure; HttpOnly; SameSite=Strict")
        response, body = self.request("/api/inspect", {"Cookie": "probe_session=synthetic-only"})
        self.assertEqual(response.status, 200)
        self.assertEqual(body["headers"]["Cookie"], "probe_session=synthetic-only")
        response, _ = self.request("/expire")
        self.assertIn("Max-Age=0", response.getheader("Set-Cookie"))
        response, body = self.request("/api/inspect")
        self.assertEqual(response.status, 401)
        self.assertEqual(body["fixture"], "expired")
        response, _ = self.request("/api/socket", {"Upgrade": "websocket"})
        self.assertEqual(response.status, 401)

    def test_websocket_handshake_and_distinct_authenticated_frame(self):
        with socket.create_connection(("127.0.0.1", self.server.server_port), timeout=3) as channel:
            channel.sendall(b"GET /api/socket HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: probe_session=synthetic-only\r\nOrigin: https://fixture.invalid\r\n\r\n")
            with channel.makefile("rb") as stream:
                self.assertIn(b"101", stream.readline())
                headers = []
                while True:
                    line = stream.readline()
                    if line == b"\r\n":
                        break
                    headers.append(line)
                self.assertIn(b"Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n", headers)
                opcode, size = stream.read(2)
                self.assertEqual(opcode, 0x81)
                if size == 126:
                    size = struct.unpack("!H", stream.read(2))[0]
                body = json.loads(stream.read(size))
                self.assertEqual(body["fixture"], "authenticated-wss")
                self.assertEqual(body["headers"]["Origin"], "https://fixture.invalid")


if __name__ == "__main__":
    unittest.main()
