// 공유 카드 PNG (1080×1920) — next/og(satori). docs/09 §4
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { getSharedReport } from "@/server/services/reports";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  let content;
  try {
    content = (await getSharedReport(token)).content;
  } catch {
    return new Response("not found", { status: 404 });
  }
  const font = await readFile(join(process.cwd(), "public", "fonts", "Pretendard-Bold.otf"));
  // satori는 폰트에 없는 글자(이모지)를 외부 CDN에서 받으려 하므로 이모지·특수기호는 제거한다 (오프라인·컨테이너 안전)
  const plain = (s: string) => s.replace(/\p{Extended_Pictographic}|️|‍/gu, "").replace(/\s{2,}/g, " ").trim();
  const headline = plain(content.shareCard.headline || content.verdict.headline);
  const subline = plain(content.shareCard.subline ?? "");
  const signature = plain(content.signature);
  const personaName = plain(content.persona.name);
  const size = headline.length > 24 ? 72 : headline.length > 14 ? 88 : 104;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "140px 96px",
          background: "linear-gradient(135deg, #ff4d6d 0%, #ff8a3d 45%, #ffd23f 100%)",
          color: "#fff",
          fontFamily: "Pretendard",
        }}
      >
        <div style={{ fontSize: 40, opacity: 0.95, display: "flex" }}>{personaName}의 판정</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
          <div style={{ fontSize: size, lineHeight: 1.2, fontWeight: 700, textShadow: "0 6px 20px rgba(0,0,0,0.25)", wordBreak: "keep-all" }}>{headline}</div>
          {subline && <div style={{ fontSize: 44, opacity: 0.95 }}>{subline}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 34, opacity: 0.9 }}>
          <span>{signature}</span>
          <span>{personaName}</span>
        </div>
      </div>
    ),
    { width: 1080, height: 1920, fonts: [{ name: "Pretendard", data: font, weight: 700, style: "normal" }], headers: { "Cache-Control": "private, max-age=300", "X-Robots-Tag": "noindex" } },
  );
}
