"""Credential-free loopback controls for Bun's buffered integrity error boundary.

Run with --bun /absolute/path/to/bun. Emits fixed diagnostics only; no raw logs.
This host control does not reproduce or qualify a different guest runtime.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import selectors
import subprocess
import tarfile
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer


def digest(data):
    return 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode('ascii')


def execute(argv, cwd, env):
    output = bytearray()
    deadline = time.monotonic() + 15
    with subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as child:
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    if time.monotonic() >= deadline:
                        raise RuntimeError('control_timeout')
                    for key, _ in selector.select(0.1):
                        chunk = os.read(key.fileobj.fileno(), 4096)
                        if not chunk:
                            selector.unregister(key.fileobj)
                        else:
                            output.extend(chunk)
                            if len(output) > 65536:
                                raise RuntimeError('control_output_budget')
                code = child.wait(timeout=max(0.01, deadline-time.monotonic()))
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=2)
    return code, bytes(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bun', type=Path, required=True)
    args = parser.parse_args()
    binary = args.bun.resolve(strict=True)
    results = []
    payload = b'owned integrity fixture contents\n'
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as archive:
        for name, data in [('package/package.json', b'{"name":"integrity-fixture","version":"1.0.0"}'),
                           ('package/payload.txt', payload)]:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    valid = buf.getvalue()
    changed = bytearray(valid)
    changed[-1] ^= 1
    malformed = b'not an archive\n'
    cases = [('valid', valid, digest(valid)),
             ('digest_mismatch', bytes(changed), digest(valid)),
             ('malformed_archive', malformed, digest(malformed))]
    with tempfile.TemporaryDirectory(prefix='hack-bun-integrity-') as root:
        root = Path(root)
        env = {'PATH': str(binary.parent) + ':/usr/bin:/bin', 'HOME': str(root),
               'TMPDIR': str(root), 'DO_NOT_TRACK': '1',
               'BUN_INSTALL_STREAMING_MIN_SIZE': '999999999999',
               'BUN_CONFIG_NO_CLEAR_TERMINAL': '1'}
        code, version = execute([str(binary), '--version'], root, env)
        assert code == 0 and version.strip() == b'1.3.14', 'wrong_bun_version'
        for name, body, expected in cases:
            requests = []

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_):
                    pass

                def do_GET(self):
                    if self.path == '/integrity-fixture':
                        metadata = {'name': 'integrity-fixture', 'dist-tags': {'latest': '1.0.0'},
                                    'versions': {'1.0.0': {'name': 'integrity-fixture', 'version': '1.0.0',
                                    'dist': {'integrity': expected, 'tarball': origin + '/fixture.tgz'}}}}
                        response = json.dumps(metadata).encode()
                        content_type = 'application/json'
                    elif self.path == '/fixture.tgz':
                        response = body
                        content_type = 'application/octet-stream'
                        requests.append(hashlib.sha256(body).hexdigest())
                    else:
                        self.send_error(404)
                        return
                    self.send_response(200)
                    self.send_header('Content-Type', content_type)
                    self.send_header('Content-Length', str(len(response)))
                    self.end_headers()
                    self.wfile.write(response)

            directory = root / name
            directory.mkdir()
            (directory/'package.json').write_text(json.dumps({'name': 'control', 'version': '1.0.0',
                                                            'dependencies': {'integrity-fixture': '1.0.0'}}))
            server = HTTPServer(('127.0.0.1', 0), Handler)
            origin = 'http://127.0.0.1:' + str(server.server_port)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                code, raw = execute([str(binary), 'install', '--ignore-scripts', '--registry', origin],
                                    directory, dict(env, BUN_INSTALL_CACHE_DIR=str(directory/'cache')))
                target = directory/'node_modules/integrity-fixture/payload.txt'
                result = {'case': name, 'exit_code': code, 'tarball_requests': len(requests),
                          'served_sha256': hashlib.sha256(body).hexdigest(),
                          'served_digest_matches_metadata': digest(body) == expected,
                          'integrity_failure': b'IntegrityCheckFailed' in raw,
                          'extraction_failure': b'extracting' in raw or b'decompressing' in raw,
                          'contents_match': target.is_file() and target.read_bytes() == payload,
                          'output_bytes': len(raw)}
                results.append(result)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
                assert not thread.is_alive(), 'server_cleanup_failed'
    assert not root.exists(), 'temporary_cleanup_failed'
    good, mismatch, invalid = results
    passed = (good['exit_code'] == 0 and good['contents_match'] and not good['integrity_failure']
              and mismatch['exit_code'] == 1 and mismatch['integrity_failure'] and not mismatch['contents_match']
              and invalid['exit_code'] == 1 and invalid['extraction_failure'] and not invalid['integrity_failure']
              and not invalid['contents_match'] and all(r['tarball_requests'] > 0 for r in results))
    print(json.dumps({'passed': passed, 'scope': 'host-loopback-buffered-diagnostic-control',
                      'bun_version': '1.3.14', 'host': platform.system(), 'architecture': platform.machine(),
                      'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
                      'cleanup_verified': True, 'cases': results}, indent=2))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
