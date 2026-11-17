# Fake hackd for the env drive: answers GET /v1/status and /v1/projects with
# one project, "demo", whose checkout is the throwaway project. Nothing else.
import json, os, socket, sys

sock_path, repo_root, version = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(os.path.dirname(sock_path), mode=0o700, exist_ok=True)
try:
    os.unlink(sock_path)
except FileNotFoundError:
    pass
bodies = {
    "/v1/status": {"status": "running", "version": version, "pid": os.getpid()},
    "/v1/projects": {
        "runtime_ok": True,
        "projects": [{
            "name": "demo", "status": "running", "repo_root": repo_root,
            "defined_services": ["api"],
            "runtime": {"project": "demo", "working_dir": repo_root + "/.hack",
                        "services": [{"service": "api", "containers": [
                            {"state": "running", "status": "Up 1 minute"}]}]},
        }],
    },
}
s = socket.socket(socket.AF_UNIX)
s.bind(sock_path)
s.listen(8)
while True:
    c, _ = s.accept()
    req = b""
    while b"\r\n\r\n" not in req:
        chunk = c.recv(4096)
        if not chunk:
            break
        req += chunk
    path = req.split(b" ")[1].decode().split("?")[0] if req.count(b" ") >= 2 else "/"
    body = json.dumps(bodies.get(path, {"error": "not in the fake"})).encode()
    status = "200 OK" if path in bodies else "404 Not Found"
    c.sendall(f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\n"
              f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
    c.close()
