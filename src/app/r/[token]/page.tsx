import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ReportView from "@/components/report/ReportView";
import { getSharedReport } from "@/server/services/reports";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  try {
    const shared = await getSharedReport(token);
    const persona = shared.content.persona.name;
    return {
      title: shared.content.verdict.headline,
      description: `${persona}의 판정 · ${shared.content.shareCard.subline}`,
      robots: { index: false, follow: false },
      openGraph: { title: shared.content.verdict.headline, description: `${persona}의 판정`, images: [{ url: `/r/${token}/card.png`, width: 1080, height: 1920 }] },
    };
  } catch {
    return { title: "보고서", robots: { index: false } };
  }
}

export default async function SharedReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let shared;
  try {
    shared = await getSharedReport(token);
  } catch {
    notFound();
  }
  const persona = shared.content.persona.name;
  return (
    <div>
      <div className="mb-6 flex items-center justify-between rounded-2xl bg-pastel-yellow px-4 py-2 text-sm text-[#6b4f00]">
        <span>{persona} 보고서 · 공유됨</span>
        <Link href="/setup" className="font-bold underline">
          내 카톡도 분석하기 →
        </Link>
      </div>
      <ReportView content={shared.content} seq={shared.seq} isOwner={false} />
      <div className="mt-10 text-center">
        <Link href="/setup" className="btn-primary">
          내 카톡도 {persona}한테 보여주기 →
        </Link>
      </div>
    </div>
  );
}
