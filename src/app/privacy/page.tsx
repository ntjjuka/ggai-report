export const metadata = { title: "개인정보 처리" };

const SECTIONS: { title: string; items: string[] }[] = [
  {
    title: "무엇을 모으나요",
    items: [
      "올린 카카오톡 대화 파일(원문)과 거기서 계산한 통계, 그리고 그 대화로 만든 보고서예요.",
      "접근 확인용 쿠키(gg_owner)는 무작위 토큰이고, 서버에는 해시만 저장해요. 이메일·전화번호 같은 계정 정보는 받지 않아요.",
      "요청 기록에는 IP 주소의 해시와 처리 시간, 오류 코드만 남고, 대화 내용·이름은 남기지 않아요.",
    ],
  },
  {
    title: "어떻게 보관하나요",
    items: [
      "원문은 AES-256-GCM으로 암호화해 저장하고, 업로드 후 7일이 지나면 자동 삭제돼요. 그 뒤에는 새 보고서를 만들 수 없어요.",
      "통계와 보고서는 직접 삭제하기 전까지 남아요. 대화 전체(원문·통계·보고서·공유 링크) 삭제와 보고서 하나만 삭제, 둘 다 가능해요.",
      "삭제는 즉시 반영되고 되돌릴 수 없어요.",
    ],
  },
  {
    title: "누구에게 전달되나요 (처리 위탁·국외 이전)",
    items: [
      "보고서를 만드는 동안에만 대화 본문이 AI 처리 위탁사 Anthropic, PBC(미국)의 API로 전송돼요. 목적은 보고서 생성이고, 해당 API는 입력을 모델 학습에 쓰지 않아요.",
      "전화번호·계좌번호·주민번호 같은 패턴은 전송 전에 가려요. 이름은 보고서 품질을 위해 그대로 보내요(위저드 이름 정리 단계에서 바꿀 수 있어요).",
      "그 밖의 제3자 제공은 없어요. 결제·광고·분석 도구를 쓰지 않아요.",
    ],
  },
  {
    title: "공개 범위",
    items: [
      "보고서는 기본 비공개예요. 공유 링크를 켜기 전까지 아무도 볼 수 없고, 링크는 언제든 끌 수 있어요.",
      "공유 페이지는 검색엔진에 노출되지 않도록 설정돼요(noindex). 공유 페이지에는 대화 원문이 아니라 보고서에 인용된 문장만 보여요.",
    ],
  },
  {
    title: "접근과 복구",
    items: [
      "접근은 이 브라우저의 쿠키로만 확인해요. 쿠키를 지우거나 다른 기기에서 열면 같은 대화를 다시 열 수 없으니 링크를 보관해 주세요.",
      "이메일로 보고서를 받거나 다른 기기에서 여는 기능은 준비 중이에요.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <article className="space-y-6 text-sm leading-relaxed">
      <h1 className="text-2xl font-extrabold">개인정보 처리 안내</h1>
      <p>올린 대화는 보고서를 만드는 목적으로만 쓰이고, 아래 원칙에 따라 다뤄져요.</p>
      {SECTIONS.map((s) => (
        <section key={s.title} className="card p-5">
          <h2 className="text-base font-extrabold">{s.title}</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {s.items.map((it) => (
              <li key={it}>{it}</li>
            ))}
          </ul>
        </section>
      ))}
      <p className="text-muted">문의: 저장소 이슈 트래커를 이용해 주세요. 최종 갱신 2026-11-03.</p>
    </article>
  );
}
