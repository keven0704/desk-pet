import asyncio, base64, os, sys

import importlib.util
spec = importlib.util.spec_from_file_location('bp', 'backend/main.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

async def main():
    # 1x1 红色像素 PNG，走真实 analyze_screenshot 流程
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
    b64 = base64.b64encode(png).decode()
    data_url = 'data:image/png;base64,' + b64
    result = await m.analyze_screenshot(data_url, {"width": 1, "height": 1})
    print("分析结果:", result)
    assert "失败" not in result.get("text", ""), "分析不应失败"
    print("PASS: max_tokens 修复后 API 调用正常")

asyncio.run(main())
