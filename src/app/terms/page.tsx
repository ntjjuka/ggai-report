export const metadata = { title: "이용 안내" };

export default function TermsPage() {
  return (
    <article className="space-y-4 text-sm leading-relaxed">
      <h1 className="text-2xl font-extrabold">이용 안내</h1>
      <ul className="list-disc space-y-1 pl-5">
        <li>보고서는 대화에서 관찰된 패턴에 대한 해석이에요. 마음을 읽는 것도, 심리·법률·의학적 진단이나 조언도 아니에요. 재미와 성찰을 위해 써 주세요.</li>
        <li>다른 사람의 대화를 올릴 때는 그 사람의 동의를 받아 주세요. 올린 사람이 내용에 대한 책임을 져요.</li>
        <li>외모·장애·질병·성적 지향 등 보호 속성을 농담 소재로 쓰지 않도록 설계했지만, AI 결과물에는 오류가 있을 수 있어요. 불쾌한 내용이 있으면 보고서를 삭제하고 알려 주세요.</li>
        <li>서비스는 예고 없이 변경·중단될 수 있어요.</li>
      </ul>
    </article>
  );
}
