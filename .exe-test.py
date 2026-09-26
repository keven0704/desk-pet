"""测试打包出来的 deskpet-backend.exe：能起来、能读 exe 旁边的 .env、WebSocket 能收发、
HTTPS 调用（certifi/SSL）没被 PyInstaller 打坏。
用法: python .exe-test.py
"""
import asyncio
import json
import os
import socket
import subprocess
import sys
import threading
import time

EXE = os.path.join("backend", "deskpet-backend.exe")
PORT = 8014
PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ"
       "AAAABJRU5ErkJggg==")


def port_busy(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def main() -> int:
    if not os.path.exists(EXE):
        print("FAIL 找不到", EXE)
        return 1
    print(f"exe 大小: {os.path.getsize(EXE) / 1024 / 1024:.1f} MB")
    if port_busy(PORT):
        print(f"FAIL 端口 {PORT} 被占用")
        return 1

    env = {**os.environ, "DESK_PET_PORT": str(PORT)}
    proc = subprocess.Popen([EXE], cwd="backend", env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace")
    # 后台线程读日志：如果直接在主线程 readline，遇到"没有任何输出"就会永久卡住
    lines = []
    printed = 0

    def reader():
        for line in proc.stdout:
            lines.append(line.rstrip())

    threading.Thread(target=reader, daemon=True).start()

    def drain():
        nonlocal printed
        while printed < len(lines):
            print("  [exe]", lines[printed])
            printed += 1

    ready_markers = ("后端启动", "Uvicorn running")
    deadline = time.time() + 60
    while time.time() < deadline:
        drain()
        if any(any(m in ln for m in ready_markers) for ln in lines):
            break
        if proc.poll() is not None:
            print(f"FAIL exe 提前退出，code={proc.returncode}")
            drain()
            return 1
        time.sleep(0.3)
    else:
        proc.kill()
        print("FAIL 60 秒内没等到启动日志")
        return 1
    print("PASS exe 独立启动成功（uvicorn 已在监听）")

    # 顺带验证：exe 有没有读到旁边的 .env（打包后最容易踩的坑，用 ASCII 的 .env 判断避免编码干扰）
    if any("backend\\.env" in ln or "backend/.env" in ln for ln in lines):
        print("PASS 读到了 exe 旁边的 .env（API Key 生效）")
    else:
        print("警告：没看到读取配置的日志，可能没读到 .env（会退化成演示模式）")
    if any("\ufffd" in ln for ln in lines):
        print("警告：后端日志有乱码（编码没统一成 UTF-8）")
    else:
        print("PASS 后端日志编码正常（UTF-8，无乱码）")

    ok = asyncio.run(ws_check())
    drain()
    kill_tree(proc)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass
    return 0 if ok else 1


def kill_tree(proc) -> None:
    """PyInstaller onefile 是 bootloader + 真进程两层，proc.kill() 只杀掉外层，
    里面真正的服务会残留（占端口 + 锁住 exe），所以 Windows 上要 taskkill /T。"""
    if os.name == "nt":
        subprocess.run(["taskkill", "/pid", str(proc.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        proc.kill()


async def ws_check() -> bool:
    import websockets

    try:
        async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws", open_timeout=15) as w:
            # 1) 配置回执：能回 asr 信息说明 config 热更新 + 配置读取都正常
            await w.send(json.dumps({"type": "config", "payload": {"provider": "glm"}}))
            ack = json.loads(await asyncio.wait_for(w.recv(), 40))
            assert ack["type"] == "guidance", ack
            print(f"PASS WS 连通 + config 回执: {ack['payload'].get('text')}"
                  f" (语音识别: {ack['payload'].get('asrDesc')})")

            # 2) 截图分析：带上 .env 里的真实 Key，验证 HTTPS 调用没被打包破坏
            await w.send(json.dumps({"type": "screenshot", "payload": {
                "image": "data:image/png;base64," + PNG,
                "displaySize": {"width": 200, "height": 200},
            }}))
            reply = None
            deadline = time.time() + 90
            while time.time() < deadline:
                msg = json.loads(await asyncio.wait_for(w.recv(), 90))
                if msg["type"] == "guidance":
                    reply = msg["payload"]
                    break
            assert reply and reply.get("text"), reply
            head = reply["text"].replace("\n", " ")[:60]
            print(f"PASS 视觉接口可用（HTTPS/SSL 正常）: {head}…")
            if "演示模式" in reply["text"]:
                print("     注意：当前没有可用 API Key（演示模式），HTTPS 未被真正验证")
        return True
    except Exception as e:
        print("FAIL WS/接口测试:", type(e).__name__, e)
        return False


if __name__ == "__main__":
    sys.exit(main())
