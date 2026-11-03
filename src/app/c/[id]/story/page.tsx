import { notFound } from "next/navigation";
import StoryViewer from "@/components/story/StoryViewer";
import { readOwner } from "@/server/owner";
import { getConversationDetail } from "@/server/services/conversations";

export const dynamic = "force-dynamic";
export const metadata = { title: "통계 보고서", robots: { index: false } };

export default async function StoryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const owner = await readOwner();
  if (!owner) notFound();
  let detail;
  try {
    detail = await getConversationDetail(id, owner.hash);
  } catch {
    notFound();
  }
  if (!detail.tier0) notFound();
  const then = typeof sp.then === "string" && sp.then.startsWith("/") ? sp.then : null;
  return <StoryViewer cards={detail.tier0.story} then={then} backHref={`/c/${id}`} persona={process.env.PERSONA_NAME ?? "까비서"} />;
}
