// tools/make-masthead.mjs —— 生成主页名字标（唯一的 SVG）：大字号衬线名字 + 细分隔线 + 一行定位。
// 设计规则（见 .design-system.md）：
//   透明背景（不画 rect，透出 GitHub 页面色）· 单色墨 · 明暗各一版 · 无渐变/发光/动画/emoji
// 用法：node tools/make-masthead.mjs <outDir>
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const outDir = process.argv[2] ?? ".qa/run";
const NAME = "Sutera Wu";
const ROLE = "local-first desktop software · windows tooling";
const META = "CN";
const W = 680;
const H = 186;

// 明暗两版的墨色；强调色只在细线上使用一次
const INK = { dark: "#ECE8E0", light: "#121212" };
const MUTED = { dark: "#7E7D78", light: "#767676" };
const ACCENT = { dark: "#3EA9B8", light: "#0E7490" };

const SERIF = `ui-serif, 'Iowan Old Style', 'Apple Garamond', Baskerville, Cambria, Georgia, 'Noto Serif SC', 'Source Han Serif SC', serif`;
const SANS = `system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif`;
const MONO = `ui-monospace, Consolas, 'Cascadia Mono', monospace`;

const render = (mode) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${NAME} — ${ROLE}">
  <text x="0" y="102" font-family="${SERIF}" font-size="92" font-weight="400" letter-spacing="-1.6" fill="${INK[mode]}">${NAME}</text>
  <line x1="0" y1="130" x2="${W}" y2="130" stroke="${ACCENT[mode]}" stroke-width="1.1" opacity="0.85"/>
  <text x="0" y="158" font-family="${SANS}" font-size="14" letter-spacing="0.5" fill="${MUTED[mode]}">${ROLE}</text>
  <text x="${W}" y="158" text-anchor="end" font-family="${MONO}" font-size="11.5" letter-spacing="1.4" fill="${MUTED[mode]}">${META}</text>
</svg>`;

mkdirSync(outDir, { recursive: true });
for (const mode of ["dark", "light"]) {
  const file = path.join(outDir, `masthead-${mode}.svg`);
  writeFileSync(file, render(mode), "utf8");
  console.log(`[masthead] ${file} (${Buffer.byteLength(render(mode))}B)`);
}
