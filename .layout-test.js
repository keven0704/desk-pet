// 临时测试：验证 drawResultCard 的布局与滚动逻辑（与 overlay.js 保持一致）
const LINE_H = 19;
function wrapText(text) {
  const lines = [];
  for (const para of text.split('\n')) {
    for (let i = 0; i < para.length; i += 22) lines.push(para.slice(i, i + 22));
  }
  return lines; // 不截断
}
function layoutCard(text, winH) {
  const cardW = Math.min(460, 1400 - 40);
  const lines = wrapText(text);
  const contentH = lines.length * LINE_H + 12 + 26;
  let cy = 160; // 框(100,50,200x100)下方 10px
  if (cy + Math.min(contentH, 320) > winH - 10) cy = Math.max(10, 50 - Math.min(contentH, 320) - 10);
  const maxCardH = winH - cy - 10;
  const cardH = Math.min(contentH, maxCardH);
  const scrollable = contentH > cardH;
  // 模拟滚动到底
  const maxScroll = scrollable ? contentH - cardH : 0;
  const visibleLines = [];
  for (let i = 0; i < lines.length; i++) {
    const py = cy + 18 + i * LINE_H - maxScroll;
    if (py > cy + cardH - 14) continue;
    if (py < cy - LINE_H) continue;
    visibleLines.push(i);
  }
  return {
    totalLines: lines.length, contentH, cardH, scrollable, maxScroll,
    lastVisible: visibleLines[visibleLines.length - 1],
    allVisible: visibleLines.length === lines.length
  };
}

// 短答案：应完整显示、无滚动
const short = layoutCard('答案是 42。', 900);
console.log('短答案:', JSON.stringify(short));
if (short.scrollable || !short.allVisible) throw new Error('短答案应完整显示');

// 长答案（50 段）：应可滚动，滚动到底能看到最后一行
const longText = Array.from({ length: 50 }, (_, i) => '第' + i + '行完整内容不被截断').join('\n');
const long = layoutCard(longText, 900);
console.log('长答案:', JSON.stringify(long));
if (!long.scrollable) throw new Error('长答案应可滚动');
if (long.lastVisible !== long.totalLines - 1) throw new Error('滚动到底应能看到最后一行');

console.log('PASS: 布局与滚动逻辑验证通过');
