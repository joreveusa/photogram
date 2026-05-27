"""
TCP relay: Windows localhost:3000 -> WSL2 NodeODM IP:3000
No admin required. Run this before the Celery worker.
"""
import socket
import threading
import subprocess
import sys
import time

def get_wsl2_ip():
    try:
        result = subprocess.run(
            ["wsl", "-d", "Ubuntu", "--", "hostname", "-I"],
            capture_output=True, text=True, timeout=10
        )
        return result.stdout.strip().split()[0]
    except Exception as e:
        print(f"Cannot get WSL2 IP: {e}")
        sys.exit(1)

def forward(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        try: src.close()
        except: pass
        try: dst.close()
        except: pass

def handle(client_sock, target_ip, target_port):
    try:
        server_sock = socket.create_connection((target_ip, target_port), timeout=10)
    except Exception as e:
        print(f"Cannot connect to {target_ip}:{target_port} — {e}")
        client_sock.close()
        return
    t1 = threading.Thread(target=forward, args=(client_sock, server_sock), daemon=True)
    t2 = threading.Thread(target=forward, args=(server_sock, client_sock), daemon=True)
    t1.start(); t2.start()

if __name__ == "__main__":
    LOCAL_PORT  = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
    REMOTE_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 3000

    wsl_ip = get_wsl2_ip()
    print(f"WSL2 IP: {wsl_ip}")
    print(f"Relay: 127.0.0.1:{LOCAL_PORT} -> {wsl_ip}:{REMOTE_PORT}")

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", LOCAL_PORT))
    server.listen(50)
    print(f"Listening on 127.0.0.1:{LOCAL_PORT} — ready")

    while True:
        try:
            client, addr = server.accept()
            threading.Thread(target=handle, args=(client, wsl_ip, REMOTE_PORT), daemon=True).start()
        except KeyboardInterrupt:
            break
