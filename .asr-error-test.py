"""语音识别故障处理自测：
1. classify_asr_error 对 429/1113（余额不足）等的分类
2. AsrError 是否带 code/hint
3. update_config 热更新语音识别服务商
4. 真跑一遍 WS voice 流程，确认失败时回的是结构化错误（errorCode + hint）
5. WS config 热更新后回带的语音识别信息
用法: python .asr-error-test.py
"""
import asyncio
import base64
import importlib.util
import json
import math
import struct
import threading
import time

import uvicorn
import websockets

spec = importlib.util.spec_from_file_location('bp', 'backend/main.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

# ---------- 1. 错误分类 ----------
CASES = [
    (429, '{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}', "insufficient_balance"),
    (429, '{"error":{"message":"account balance not enough"}}', "insufficient_balance"),
    (402, '{"error":{"message":"payment required"}}', "insufficient_balance"),
    (400, '{"error":{"code":"1210","message":"API 调用参数有误，请检查文档。no audio segment found"}}', "no_speech"),
    (429, '{"error":{"message":"rate limit reached"}}', "rate_limit"),
    (401, '{"error":{"message":"invalid api key"}}', "auth"),
    (403, "forbidden", "auth"),
    (404, "model not found", "api_error"),
    (500, "internal error", "network"),
    (400, "bad request", "api_error"),
]
for status, body, expect in CASES:
    code, why = m.classify_asr_error(status, body)
    assert code == expect, f"status={status} body={body!r} -> {code}，期望 {expect}"
    assert why, "分类说明不该为空"
print(f"PASS 1: classify_asr_error {len(CASES)} 组用例分类正确（429/1113 → insufficient_balance）")

# ---------- 2. AsrError 带 code/hint ----------
err = m.AsrError("x", "insufficient_balance", m.ASR_HINTS["insufficient_balance"])
assert err.code == "insufficient_balance" and "余额不足" in err.hint and str(err) == "x"
print("PASS 2: AsrError 携带 errorCode(=%s) 与 hint" % err.code)

# ---------- 3. asr_config / update_config ----------
m.ASR_PROVIDER_ENV = m.ASR_URL_ENV = m.ASR_MODEL_ENV = m.ASR_KEY_ENV = ""
cfg = m.asr_config()
assert cfg["provider"] == "glm" and cfg["model"] == "glm-asr" and cfg["url"].endswith("/audio/transcriptions"), cfg
m.update_config({"asrProvider": "siliconflow", "asrModel": ""})
cfg = m.asr_config()
assert cfg["provider"] == "siliconflow" and cfg["model"] == "FunAudioLLM/SenseVoiceSmall", cfg
m.update_config({"asrProvider": "custom", "asrApiUrl": "https://x.test/v1/audio/transcriptions",
                 "asrModel": "my-asr", "asrApiKey": "sk-test"})
cfg = m.asr_config()
assert cfg == {"provider": "custom", "url": "https://x.test/v1/audio/transcriptions",
               "model": "my-asr", "key": "sk-test"}, cfg
# 还原成跟随主服务商，方便第 4 步打真实接口
m.update_config({"asrProvider": "", "asrApiUrl": "", "asrModel": "", "asrApiKey": ""})
assert m.asr_config()["model"] == "glm-asr", m.asr_config()
print("PASS 3: 语音识别配置可热更新（siliconflow / custom / 跟随主服务商）")


def tiny_wav_data_url() -> str:
    """0.5 秒 16kHz 440Hz 正弦音（当"人声"占位）：纯静音会被智谱判成
    "no audio segment found"，测不到真实业务错误（如余额不足）。"""
    rate, dur = 16000, 0.5
    n = int(rate * dur)
    frames = bytearray()
    for i in range(n):
        val = int(9000 * math.sin(2 * math.pi * 440 * i / rate))
        frames += struct.pack("<h", val)
    header = (b"RIFF" + struct.pack("<I", 36 + len(frames)) + b"WAVEfmt "
              + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
              + b"data" + struct.pack("<I", len(frames)))
    return "data:audio/wav;base64," + base64.b64encode(header + bytes(frames)).decode()


async def ws_checks() -> None:
    original_key = m.API_KEY
    async with websockets.connect("ws://127.0.0.1:8011/ws", open_timeout=10) as w:
        # 4. voice(mode=wake) → 识别失败时必须回结构化错误
        await w.send(json.dumps({"type": "voice", "payload": {"audio": tiny_wav_data_url(), "mode": "wake"}}))
        got = None
        for _ in range(3):
            msg = json.loads(await asyncio.wait_for(w.recv(), 120))
            if msg["type"] == "voice-transcript":
                got = msg["payload"]
                break
        assert got is not None, "没有收到 voice-transcript"
        assert got.get("error"), f"应带 error：{got}"
        assert got.get("errorCode") in m.ASR_HINTS, f"errorCode 不在已知分类里：{got}"
        assert "hint" in got and got.get("scope") == "wake", got
        print(f"PASS 4: voice(wake) 失败回结构化错误 errorCode={got['errorCode']}")
        print(f"        error={got['error']}")
        print(f"        hint={got['hint']}")
        if got["errorCode"] == "insufficient_balance":
            print("        → 真实接口的 429/1113 被正确识别为「余额不足」，前端会暂停唤醒并弹补救提示")
        else:
            print(f"        → 注意：本次真实接口返回被归为 {got['errorCode']}（可能 Key/网络状态已变）")

        # 5. config 热更新 → 回带的语音识别信息
        await w.send(json.dumps({"type": "config", "payload": {
            "provider": "glm", "asrProvider": "siliconflow", "asrApiKey": "sk-fake",
        }}))
        ack = json.loads(await asyncio.wait_for(w.recv(), 30))
        assert ack["type"] == "guidance" and ack["payload"].get("asr"), ack
        assert ack["payload"]["asr"]["model"] == "FunAudioLLM/SenseVoiceSmall", ack
        print("PASS 5: config 热更新会回带当前语音识别模型（%s）" % ack["payload"]["asrDesc"])

        # 6. 演示模式：完全没有 API Key（别人拿到不带 backend/.env 的版本就是这个状态）
        m.API_KEY = ""
        png = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ"
               "AAAABJRU5ErkJggg==")
        await w.send(json.dumps({"type": "screenshot", "payload": {
            "image": "data:image/png;base64," + png,
            "displaySize": {"width": 1, "height": 1},
        }}))
        demo = None
        for _ in range(3):
            msg = json.loads(await asyncio.wait_for(w.recv(), 30))
            if msg["type"] == "guidance":
                demo = msg["payload"]
                break
        assert demo and demo.get("text"), f"演示模式应该返回示例文字：{demo}"
        print(f"PASS 6: 无 Key 时截图走演示模式（{demo['text'][:18]}…）")

        # 7. 演示模式下的语音唤醒：听不出内容就不该自动唤醒（否则没喊它也会弹框）
        await w.send(json.dumps({"type": "voice", "payload": {"audio": tiny_wav_data_url(), "mode": "wake"}}))
        msg = json.loads(await asyncio.wait_for(w.recv(), 30))
        assert msg["type"] == "voice-transcript" and msg["payload"].get("wakeResult") == "demo", msg
        try:
            extra = json.loads(await asyncio.wait_for(w.recv(), 1.5))
            assert extra["type"] != "wake-triggered", f"演示模式不该触发唤醒：{extra}"
        except asyncio.TimeoutError:
            pass
        m.API_KEY = original_key
        print("PASS 7: 演示模式不再自动唤醒（没配 Key 时听不出内容，也不弹框）")


def _wake_tests() -> None:
    """唤醒词匹配：只认"开头喊的噜噜"（含同音写法），正文里出现的同音词不能误触发。"""
    hits = [
        "噜噜，这个题怎么做", "露露这个题怎么做", "鹿鹿，帮我看看这题", "录录这个题怎么做",
        "碌碌", "鲁鲁这个题", "卢卢，翻译一下", "路路，这报错怎么回事", "陆陆", "卤卤",
        "LULU what is this", "lulu, help me", "lvlu", "lu lu 这个题",
        "噜。噜 这个题怎么做",   # 标点隔开也算
        "喂，噜噜，这个题",      # 前面带语气词/标点也算
        "嗯那个卢卢这题",        # 前面夹口语词也算
    ]
    misses = [
        "", "这个题怎么做", "露水好大", "路口左转", "卤蛋好吃", "录音笔在哪",
        "陆家嘴怎么走", "卢布汇率多少",
        # 这些以前会误唤醒（正文里出现同音词），现在必须忽略
        "我在看录录的视频", "把声音录录下来", "他的名字叫卢卢吗", "这条路路况不错",
        "老师说鹿鹿很可爱", "这里陆陆续续来人了",
    ]
    for t in hits:
        assert m.contains_wake_word(t), f"应识别为唤醒词：{t!r}"
    for t in misses:
        assert not m.contains_wake_word(t), f"不该识别为唤醒词（会误唤醒）：{t!r}"
    print(f"PASS 6: 唤醒词匹配 {len(hits)} 命中 / {len(misses)} 不误报"
          f"（含 鹿鹿/录录/碌碌/鲁鲁 等同音字，且正文里的同音词不会误触发）")


print("---- 唤醒词 ----")
_wake_tests()

cfg = uvicorn.Config(m.app, host="127.0.0.1", port=8011, log_level="error")
server = uvicorn.Server(cfg)
threading.Thread(target=server.run, daemon=True).start()
for _ in range(120):
    if server.started:
        break
    time.sleep(0.1)
assert server.started, "测试用后端没起来"

try:
    asyncio.run(ws_checks())
except OSError as e:
    print(f"跳过 4/5：连不上外网或接口不可达（{e}）")
finally:
    server.should_exit = True

print("全部完成")
