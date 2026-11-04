import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

const PERSONA = process.env.PERSONA_NAME ?? "까비서";

export const metadata: Metadata = {
  title: { default: `${PERSONA} — 카톡 다 읽고 솔직하게 말해주는 비서`, template: `%s · ${PERSONA}` },
  description: `카카오톡 대화를 올리면 ${PERSONA}가 끝까지 읽고 누가 더 마음 쓰는지, 언제 바뀌었는지, 지금 뭘 해야 하는지 솔직하게 보고합니다.`,
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#ffffff" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen">
        <header className="sticky top-0 z-20 border-b border-line bg-white/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
            <Link href="/" className="text-lg font-extrabold tracking-tight">
              {PERSONA}
            </Link>
            <nav className="flex items-center gap-4 text-sm text-muted">
              <Link href="/my" className="hover:text-ink">
                내 보고서
              </Link>
              <Link href="/guide/export" className="hover:text-ink">
                내보내기 방법
              </Link>
              <Link href="/setup" className="btn-primary !py-2 !px-4 text-sm">
                시작하기
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-3xl px-4 pb-24 pt-6">{children}</main>
        <footer className="mx-auto max-w-3xl px-4 pb-10 text-xs text-muted">
          <p>
            {PERSONA}의 보고서는 대화에서 관찰된 패턴에 대한 해석이에요. 마음을 읽는 것도, 진단이나 전문 조언도 아니에요. ·{" "}
            <Link href="/privacy" className="underline">
              개인정보
            </Link>{" "}
            ·{" "}
            <Link href="/terms" className="underline">
              이용약관
            </Link>
          </p>
        </footer>
      </body>
    </html>
  );
}
