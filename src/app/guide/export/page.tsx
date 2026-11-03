import Link from "next/link";

export const metadata = { title: "카카오톡 대화 내보내기 방법" };

export default function ExportGuidePage() {
  return (
    <article className="prose-sm max-w-none space-y-8">
      <h1 className="text-3xl font-extrabold">카카오톡 대화 내보내기</h1>
      <p className="text-muted">텍스트만 내보내면 충분해요. 사진·동영상은 필요 없고, 올려도 자동으로 무시돼요.</p>

      <section className="card p-5">
        <h2 className="text-lg font-bold">📱 Android</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
          <li>채팅방 오른쪽 위 ≡ 메뉴 → ⚙ 채팅방 설정</li>
          <li>「대화 내용 내보내기」 → 「텍스트 메시지만 보내기」 또는 「저장」</li>
          <li>내 파일 › KakaoTalk › Chats 폴더의 <code>KakaoTalkChats.txt</code> 를 올려 주세요 (여러 개로 나뉘면 전부 함께)</li>
        </ol>
      </section>

      <section className="card p-5">
        <h2 className="text-lg font-bold">📱 iPhone</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
          <li>채팅방 오른쪽 위 ≡ 메뉴 → ⚙ 채팅방 설정</li>
          <li>「대화 내용 내보내기」 → 「텍스트 메시지만 보내기」(메일로 보내 파일 저장) 또는 「모든 메시지 도큐먼트로 저장」(zip)</li>
          <li>파일 앱 › 나의 iPhone › 카카오톡 폴더의 zip 또는 txt 를 그대로 올려 주세요</li>
        </ol>
      </section>

      <section className="card p-5">
        <h2 className="text-lg font-bold">📲 휴대폰에서 바로 올리기</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li>휴대폰 브라우저에서도 그대로 올릴 수 있어요. 「눌러서 올리기」를 누르면 파일 앱이 열려요.</li>
          <li>「텍스트 메시지만 보내기」로 메일·카톡에 보냈다면, 첨부 파일을 내려받은 뒤 그 파일을 고르면 돼요.</li>
          <li>PC에서 올리고 싶으면 파일을 PC로 옮기면 돼요. PC 카카오톡 저장 파일은 최근 대화만 들어 있을 수 있어요.</li>
        </ul>
      </section>

      <section className="card p-5">
        <h2 className="text-lg font-bold">💻 PC</h2>
        <ul className="mt-2 space-y-1 text-sm">
          <li>
            <b>Windows용 카카오톡:</b> 채팅방을 열고 <kbd className="rounded bg-gray-100 px-1">Ctrl</kbd> + <kbd className="rounded bg-gray-100 px-1">S</kbd> 를 눌러 파일을 저장하세요.
          </li>
          <li>
            <b>Mac용 카카오톡:</b> 채팅방을 열고 오른쪽 위 ≡ 버튼을 누른 다음, 채팅방 설정에서 대화 내용을 저장하세요.
          </li>
        </ul>
        <p className="mt-3 rounded-2xl bg-pastel-yellow px-4 py-3 text-sm text-[#6b4f00]">컴퓨터에는 최근 메시지만 있을 수 있어요. 대화 전체를 보내려면 휴대폰에서 내보내 주세요.</p>
      </section>

      <section className="card p-5">
        <h2 className="text-lg font-bold">지원하는 파일</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li>.txt (Android·iPhone·PC 내보내기, 영문 설정 기기 포함), .csv (Mac), .zip (iPhone 도큐먼트 저장)</li>
          <li>최대 50MB, 메시지 30만 개, 참여자 60명. 최소 30개 메시지</li>
          <li>여러 개로 나뉜 파일(…-1.txt, -2.txt)은 한 번에 올리면 이어 붙여요</li>
        </ul>
      </section>

      <Link href="/setup" className="btn-primary">
        준비됐어요, 올리러 가기 →
      </Link>
    </article>
  );
}
