import asyncio, base64, io, os, sys

import importlib.util
spec = importlib.util.spec_from_file_location('bp', 'backend/main.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

async def main():
    # 用 Pillow 生成一张含数学题的 PNG，模拟用户框选题目的场景
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new('RGB', (700, 120), 'white')
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype('msyh.ttc', 22)  # Windows 微软雅黑
    except OSError:
        font = ImageFont.load_default()
    d.text((20, 45), '鸡兔同笼：鸡兔共35个头，94只脚，问鸡兔各几只？', font=font, fill='black')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    data_url = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()

    result = await m.analyze_screenshot(data_url, {"width": 700, "height": 120})
    print("=== AI 完整回答 ===")
    print(result.get("text"))
    print("=== 检查 ===")
    text = result.get("text", "")
    has_process = ('1.' in text or '设' in text) and ('答案' in text or '只' in text)
    if not has_process:
        raise AssertionError("回答缺少解题步骤")
    print("PASS: 回答包含解题步骤和最终答案")

asyncio.run(main())
