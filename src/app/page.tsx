import Link from "next/link";

const PERSONA = process.env.PERSONA_NAME ?? "까비서";

const SAMPLE = {
  headline: "둘 중 한 명만 연애 중이다",
  body: [
    "결론부터. 서연이 선톡의 71%를 쳤고, 지훈 답장 중앙값은 2시간 41분이야. 이건 카톡이 아니라 등기우편이야.",
    "그런데 m8812를 봐. 19일 침묵을 깬 것도 서연이고, 지훈의 첫 답은 '아 맞다'였어. 바빴다는 말이 아니라 잊고 있었다는 말이야.",
  ],
  award: "읽씹 장인상 — 지훈 — 평균 2시간 41분, 최장 19일",
};

export default function HomePage() {
  return (
    <div className="space-y-12">
      <section className="pt-6">
        <p className="mb-3 text-sm font-semibold text-muted">카톡 다 읽고 솔직하게 말해주는 비서</p>
        <h1 className="text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
          카톡 올리면 {PERSONA}가 끝까지 읽고,
          <br />
          누가 더 마음 쓰는지 보고할게.
        </h1>
        <p className="mt-4 text-lg text-muted">연애, 썸, 친구 단톡방, 가족, 회사. 두 명 이상이 말한 대화라면 {PERSONA}는 의견이 있어.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/setup" className="btn-primary">
            대화 올리고 보고서 받기 →
          </Link>
          <Link href="/guide/export" className="btn-secondary">
            카톡 내보내기 방법
          </Link>
        </div>
        <p className="mt-3 text-xs text-muted">통계 보고서는 즉시·무료. 올린 대화는 암호화되고 7일 뒤 자동 삭제돼요.</p>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          ["1", "카톡에서 내보내기", "채팅방 설정 → 대화 내용 내보내기. txt·zip 그대로 올리면 돼요."],
          ["2", "참여자 확인", "같은 사람이 두 번 나오면 합치고, 별명은 간단한 이름으로."],
          ["3", `${PERSONA}의 보고서`, "판정, 진짜 역학, 바뀐 주, 인물별 의견, 비서 제안 3건, 이달의 상."],
        ].map(([n, t, d]) => (
          <div key={n} className="card p-5">
            <div className="mb-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-ink text-sm font-bold text-white">{n}</div>
            <h3 className="font-bold">{t}</h3>
            <p className="mt-1 text-sm text-muted">{d}</p>
          </div>
        ))}
      </section>

      <section>
        <h2 className="mb-3 text-xl font-extrabold">이런 식으로 말해요 (가상 대화)</h2>
        <div className="card p-6">
          <div className="text-xs font-semibold text-muted">{PERSONA} 보고서 No.1 · 결론 보고</div>
          <h3 className="mt-2 text-2xl font-extrabold">{SAMPLE.headline}</h3>
          {SAMPLE.body.map((p) => (
            <p key={p} className="mt-3 leading-relaxed">
              {p}
            </p>
          ))}
          <div className="mt-4 rounded-2xl bg-pastel-yellow px-4 py-3 text-sm font-semibold text-[#6b4f00]">🏆 {SAMPLE.award}</div>
          <p className="mt-4 text-sm text-muted">보고 끝. 결재는 네가 해.</p>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          ["근거는 실제 메시지", `${PERSONA}가 인용하는 문장은 전부 네 대화에 실제로 있는 메시지야. 서버가 ID로 대조해.`],
          ["숫자는 서버가 센다", "선톡 비율, 답장 속도, 새벽 메시지. 숫자는 계산한 값만 쓰고 지어내지 않아."],
          ["비공개 기본", "링크를 켜기 전까지 아무도 못 봐. 원문은 암호화 저장, 7일 뒤 삭제, 언제든 직접 삭제."],
        ].map(([t, d]) => (
          <div key={t} className="rounded-3xl bg-pastel-mint p-5 text-[#115c43]">
            <h3 className="font-bold">{t}</h3>
            <p className="mt-1 text-sm opacity-80">{d}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
