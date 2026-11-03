import Wizard from "@/components/setup/Wizard";

export const metadata = { title: "대화 올리기", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function SetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const c = typeof sp.c === "string" ? sp.c : undefined;
  const back = typeof sp.back === "string" && sp.back.startsWith("/") ? sp.back : undefined;
  return <Wizard persona={process.env.PERSONA_NAME ?? "까비서"} initialConversationId={c} backHref={back} />;
}
