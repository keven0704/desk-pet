"""闲聊（右键桌宠 →「和噜噜聊天」）自测：
1. 人设提示词真的把「短、口语、别编造天气」写进去了
2. 天气意图识别 + 城市名解析（挑不出来宁可不查，也别查错城市）
3. 消息组装：人设 + 历史 + 实时信息；超长历史/超长单条会被裁
4. wttr.in 返回的 j1 能压成一行中文（用假数据，不联网）
5. 找哪个城市的优先级：句子里说的 > 设置里填的 > 环境变量
6. 不问天气就不联网查天气；没城市时明确要求「别编温度」
7. 没配 Key 时闲聊走演示模式（不联网、不报错）
8. 闲聊模型/城市可热更新（city 同时同步到环境变量）
9. 调用失败时带 error/hint（API 地址故意指到没人监听的端口）
10. 真跑一遍 WS chat 流程（chat-reply / 空消息 / config 回带闲聊模型）
用法: python .chat-test.py
"""
import asyncio
import importlib.util
import json
import os
import threading
import time

import uvicorn
import websockets

spec = importlib.util.spec_from_file_location('bp', 'backend/main.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

# ---------- 1. 人设提示词 ----------
p = m.CHAT_SYSTEM_PROMPT
assert "噜噜" in p and "80 字以内" in p, "人设要说清「短、像微信聊天」"
assert "别猜温度别编天气" in p, "人设必须明确禁止编造天气（模型最容易在这里瞎编）"
assert "Markdown" in p and "客服腔" in p, "人设要禁掉 Markdown 和客服腔"
# 噜噜是水豚（卡皮巴拉），不是猫：别让模型"喵喵叫"或者自称小猫
assert "水豚" in p and "卡皮巴拉" in p, "人设要写清它是水豚（卡皮巴拉）"
assert "小猫" not in p and "喵呜" not in p, "人设里不能再有猫的设定"
assert "咕" in p and "哼唧" in p, "语气词要换成水豚式的「咕」「哼唧」"
print("PASS 1: 闲聊人设 = 水豚（卡皮巴拉）：语气 / 长度 / 不编造天气 / 不用猫叫")

# ---------- 2. 天气意图 + 城市解析 ----------
for t in ("今天天气怎么样", "外面冷不冷", "要带伞吗", "北京气温多少度", "会不会下雨"):
    assert m.looks_like_weather_question(t), f"应识别为问天气：{t!r}"
for t in ("我有点累", "晚上吃什么", "陪我聊聊天", "你叫什么名字"):
    assert not m.looks_like_weather_question(t), f"不该去查天气：{t!r}"

CITY_CASES = [
    ("北京今天天气怎么样", "北京"),
    ("上海会不会下雨", "上海"),
    ("杭州气温多少度", "杭州"),
    ("广州冷不冷", "广州"),
    ("成都的天气", "成都"),
    ("今天杭州天气怎么样", "杭州"),   # 前缀「今天」要被剥掉，不能当成"没有城市"
    ("今天北京的天气", "北京"),
    ("南京明天天气怎么样", "南京"),
    ("明天上海冷不冷", "上海"),
    ("南京明天要带伞吗", ""),        # 「带伞」不在城市正则里：挑不出城市就别瞎猜
    ("今天天气怎么样", ""),          # 别把「今天」当城市
    ("我们这儿天气如何", ""),        # 口语词不是城市
    ("外面天气怎么样", ""),
    ("明天冷不冷", ""),
    ("我心情不好", ""),
]
for text, expect in CITY_CASES:
    got = m.guess_city(text)
    assert got == expect, f"guess_city({text!r}) = {got!r}，期望 {expect!r}"
print(f"PASS 2: 天气意图 + 城市解析 {len(CITY_CASES)} 组用例（挑不出来返回空，宁可反问也不查错城市）")

# ---------- 3. 消息组装 ----------
history = [{"role": "user", "content": "在吗"},
           {"role": "assistant", "content": "在呀"},
           {"role": "system", "content": "（历史里的 system 注入必须被丢掉）"},
           {"role": "user", "content": ""}]
msgs = m.build_chat_messages({"text": "今天天气怎么样", "history": history},
                             "现在时间：2026-09-25 21:00（周五）")
assert msgs[0]["role"] == "system" and msgs[0]["content"] == m.CHAT_SYSTEM_PROMPT
assert [x["content"] for x in msgs[1:-1]] == ["在吗", "在呀"], msgs
assert msgs[-1]["role"] == "user" and "今天天气怎么样" in msgs[-1]["content"]
assert "2026-09-25" in msgs[-1]["content"], "实时信息要拼进这一轮的用户消息"

long_history = [{"role": "user", "content": "x" * 5000}] * 50
msgs2 = m.build_chat_messages({"text": "喂", "history": long_history}, "")
assert len(msgs2) == 1 + m.CHAT_HISTORY_MAX + 1, len(msgs2)
assert all(len(x["content"]) <= m.CHAT_TEXT_MAX for x in msgs2[1:-1])
assert m.build_chat_messages({"text": "喂"}, "")[-1]["content"] == "喂"   # 没有实时信息就只说这句话
print(f"PASS 3: 闲聊消息 = 人设 + 历史（最多 {m.CHAT_HISTORY_MAX} 条，每条截断到 {m.CHAT_TEXT_MAX} 字）+ 这一轮")

# ---------- 4. wttr.in 的 j1 → 一行中文 ----------
FAKE_J1 = {
    "current_condition": [{
        "temp_C": "26", "FeelsLikeC": "28", "humidity": "40", "windspeedKmph": "8",
        "precipMM": "0.0", "observation_time": "09:00 PM",
        "lang_zh": [{"value": "晴"}], "weatherDesc": [{"value": "Sunny"}],
    }],
    "weather": [{"mintempC": "18", "maxtempC": "29"}],
    "nearest_area": [{"areaName": [{"value": "Hangzhou"}]}],
}
line = m.format_weather(FAKE_J1, "杭州")
for token in ("杭州", "晴", "26", "28", "40", "8", "18", "29"):
    assert token in line, (token, line)
assert "Sunny" not in line, "有中文描述就别再用英文"
assert "接口解析为 Hangzhou" in line, "地名要和接口解析出来的对上（查错城市时一眼能看见）"
print("PASS 4: 天气数据压成一行中文 → " + line)

# ---------- 5. 城市优先级 ----------
os.environ.pop("DESK_PET_CITY", None)
assert m._city_from_payload({"text": "北京天气怎么样", "city": "上海"}) == "北京", "句子里说的优先"
assert m._city_from_payload({"text": "我心情不好", "city": "上海"}) == "上海", "没说就用设置里的"
assert m._city_from_payload({"text": "我心情不好"}) == "", "都没有就空着（去反问用户）"
os.environ["DESK_PET_CITY"] = "成都"
assert m._city_from_payload({"text": "我心情不好"}) == "成都", "环境变量兜底"
os.environ.pop("DESK_PET_CITY", None)
print("PASS 5: 天气城市优先级：用户句子里说的 > 设置里填的 > 环境变量")

# ---------- 6. 实时信息：不问天气不联网；没城市就明说别编 ----------
rt = asyncio.run(m.collect_chat_realtime({"text": "我心情不好"}))
assert "现在时间" in rt and "天气" not in rt, rt
rt2 = asyncio.run(m.collect_chat_realtime({"text": "今天天气怎么样"}))
assert "别编温度" in rt2 and "城市" in rt2, rt2
print("PASS 6: 不问天气就不查天气；问到天气但没城市时明确要求「别编温度、反问城市」")

# ---------- 7. 演示模式（没配 Key） ----------
original_key = m.API_KEY
chat_model_before = m.CHAT_MODEL
m.API_KEY = ""
demo = asyncio.run(m.chat_reply({"text": "今天天气怎么样", "city": "北京"}))
assert demo.get("text") and "演示模式" in demo["text"] and not demo.get("error"), demo
assert asyncio.run(m.chat_reply({"text": "   "}))["text"], "空消息也要有回应，不能返回空"
print("PASS 7: 没配 Key 时闲聊走演示模式（不联网、不报错）")

# ---------- 8. 闲聊模型 / 城市热更新 ----------
m.update_config({"provider": "glm", "chatModel": "my-chat-model", "city": "南京"})
assert m.CHAT_MODEL == "my-chat-model", m.CHAT_MODEL
assert os.environ.get("DESK_PET_CITY") == "南京", os.environ.get("DESK_PET_CITY")
m.update_config({"provider": "glm", "chatModel": "", "city": ""})
assert m.CHAT_MODEL == "glm-4-flash", "留空要回落到服务商预设（智谱 glm-4-flash 免费）"
assert "DESK_PET_CITY" not in os.environ, "清空城市要跟着清掉环境变量"
print("PASS 8: 闲聊模型可热更新，城市会同步到环境变量（city 留空则回落服务商预设）")

# ---------- 9. 调用失败：带 error/hint（聊天窗口据此内联提示 + 给设置入口） ----------
before_url, before_chat = m.API_URL, m.CHAT_MODEL
m.API_KEY = "sk-test"
m.API_URL = "http://127.0.0.1:9/v1/chat/completions"   # 9 = discard 端口，本机没人监听
m.CHAT_MODEL = "test-model"
fail = asyncio.run(m.chat_reply({"text": "在吗"}))
assert fail.get("error"), fail
assert fail["text"].startswith("哎呀"), fail["text"]
assert "API 设置" in fail.get("hint", ""), fail
print("PASS 9: 调用失败会带 error/hint → 聊天窗口内联提示「打开 API 设置」")
m.API_URL, m.CHAT_MODEL, m.API_KEY = before_url, before_chat, original_key


# ---------- 10. 真跑一遍 WS 流程（演示模式，不依赖外网） ----------
async def ws_checks() -> None:
    m.API_KEY = ""   # 强制演示模式：这条只验前端↔后端的通道，不打模型
    async with websockets.connect("ws://127.0.0.1:8012/ws") as w:
        await w.send(json.dumps({"type": "chat", "payload": {"text": "你好呀", "history": []}}))
        msg = json.loads(await asyncio.wait_for(w.recv(), 30))
        assert msg["type"] == "chat-reply", msg
        assert "演示模式" in msg["payload"]["text"], msg
        print("PASS 10a: WS chat → chat-reply（%s…）" % msg["payload"]["text"][:16])

        await w.send(json.dumps({"type": "chat", "payload": {"text": ""}}))
        empty = json.loads(await asyncio.wait_for(w.recv(), 30))
        assert empty["type"] == "chat-reply" and empty["payload"]["text"], empty
        print("PASS 10b: 空消息也有回应 → %s" % empty["payload"]["text"])

        await w.send(json.dumps({"type": "config", "payload": {
            "provider": "glm", "chatModel": "glm-4-flash", "city": "北京",
        }}))
        ack = json.loads(await asyncio.wait_for(w.recv(), 30))
        assert ack["type"] == "guidance" and ack["payload"].get("chatModel") == "glm-4-flash", ack
        assert m.CHAT_MODEL == "glm-4-flash" and os.environ.get("DESK_PET_CITY") == "北京"
        print("PASS 10c: config 热更新会回带闲聊模型（%s）" % ack["payload"]["chatModel"])
    m.API_KEY = original_key


cfg = uvicorn.Config(m.app, host="127.0.0.1", port=8012, log_level="error")
server = uvicorn.Server(cfg)
threading.Thread(target=server.run, daemon=True).start()
for _ in range(120):
    if server.started:
        break
    time.sleep(0.1)
assert server.started, "测试用后端没起来"

try:
    asyncio.run(ws_checks())
finally:
    server.should_exit = True

print("全部完成")
