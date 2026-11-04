// 페이지 스크린샷 (수동 검수용). 사용: node scripts/screenshots.cjs <baseUrl> <cookieJar> <conversationId> <seq> <outDir>
// CJS: 전역 설치된 playwright 를 require 로 찾는다
const { chromium } = require("playwright");
const { readFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

(async () => {

const [, , base, jarPath, cid, seq, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });
const jar = readFileSync(jarPath, "utf8");
const line = jar.split("\n").find((l) => l.includes("gg_owner"));
const token = line ? line.trim().split("\t").pop() : null;
if (!token) throw new Error("gg_owner cookie not found in jar");
const url = new URL(base);

const browser = await chromium.launch();
async function shoot(name, path, { width = 430, height = 900, scale = 2, full = true, actions } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, locale: "ko-KR" });
  await ctx.addCookies([{ name: "gg_owner", value: token, domain: url.hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  const page = await ctx.newPage();
  await page.goto(base + path, { waitUntil: "networkidle" });
  if (actions) await actions(page);
  await page.waitForTimeout(300);
  const file = join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  console.log("saved", file);
  await ctx.close();
}

await shoot("01-landing-mobile", "/");
await shoot("01-landing-desktop", "/", { width: 1280, height: 900, scale: 1 });
await shoot("02-setup-step1", "/setup");
await shoot("03-story-1", `/c/${cid}/story`);
await shoot("03-story-2", `/c/${cid}/story`, { actions: async (p) => p.getByRole("button", { name: /다음/ }).click() });
await shoot("03-story-3", `/c/${cid}/story`, {
  actions: async (p) => {
    await p.getByRole("button", { name: /다음/ }).click();
    await p.getByRole("button", { name: /다음/ }).click();
  },
});
await shoot("03-story-7", `/c/${cid}/story`, {
  actions: async (p) => {
    for (let i = 0; i < 6; i++) await p.getByRole("button", { name: /다음/ }).click();
  },
});
await shoot("04-report", `/c/${cid}/reports/${seq}`);
await shoot("05-dashboard", `/c/${cid}`);
await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
