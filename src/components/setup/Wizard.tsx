"use client";
// 설정 위저드 7단계 (docs/17 실측 흐름): 유형 → 앱 → 업로드 → 참여자 → 이름 정리 → 언어 → 보고서 만들기
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ClientApiError } from "@/components/api";
import { Avatar, Bar, WizardHeader, colorFor } from "@/components/ui";

const TOTAL = 7;

interface ParticipantView {
  participantId: string;
  rawName: string;
  displayName: string;
  messageCount: number;
  isBot: boolean;
  excluded: boolean;
  mergedIntoId: string | null;
  isUploader: boolean;
}
interface Detail {
  conversationId: string;
  title: string | null;
  messageCount: number;
  textMessageCount: number;
  participants: ParticipantView[];
  suggestedMerges: { from: string; into: string; confidence: number }[];
  warnings: string[];
  uploaderParticipantId: string | null;
  defaultFocus: string;
  tier0: { signal: string; signalLabel: string } | null;
  signal: { grade: string; label: string; reasons: string[] } | null;
  reports: { seq: number; status: string }[];
}

const TYPES = [
  { key: "ROMANCE", icon: "💌", bg: "#ffd1e8", title: "연애", sub: "애인, 썸, 전 애인…" },
  { key: "FRIENDS_GROUP", icon: "😂", bg: "#ffe08a", title: "친구 단톡방", sub: "과동기, 여행 단톡방, 운동 모임…" },
  { key: "FRIEND_ONE", icon: "🫶", bg: "#bff0d8", title: "친구 한 명", sub: "베프, 소꿉친구, 회사 절친…" },
  { key: "FAMILY", icon: "🏠", bg: "#ffd0b8", title: "가족", sub: "가족 단톡방, 엄마나 아빠, 형제자매…" },
  { key: "WORK", icon: "📋", bg: "#c9d4ff", title: "회사 / 팀", sub: "팀 단톡방, 동료, 상사…" },
  { key: "OTHER", icon: "🤷", bg: "#d9c8ff", title: "기타", sub: "룸메이트, 이웃, 그 밖의 모든 대화…" },
];
const APPS = [
  { key: "KAKAO", title: "카카오톡", badge: "TALK", bg: "#fae100", fg: "#3c1e1e", enabled: true },
  { key: "WHATSAPP", title: "WhatsApp", badge: "W", bg: "#25d366", fg: "#fff", enabled: false },
  { key: "IMESSAGE", title: "iMessage", badge: "i", bg: "#34c759", fg: "#fff", enabled: false },
  { key: "INSTAGRAM", title: "Instagram", badge: "IG", bg: "#e1306c", fg: "#fff", enabled: false },
  { key: "MESSENGER", title: "Messenger", badge: "M", bg: "#7b5cff", fg: "#fff", enabled: false },
  { key: "LINE", title: "LINE", badge: "LINE", bg: "#06c755", fg: "#fff", enabled: false },
];
const LANGS = [
  ["KR", "한국어", true],
  ["GB", "영어", false],
  ["ES", "스페인어", false],
  ["FR", "프랑스어", false],
  ["IT", "이탈리아어", false],
  ["DE", "독일어", false],
  ["JP", "일본어", false],
  ["CN", "중국어", false],
  ["ID", "인도네시아어", false],
] as const;

export default function Wizard({ persona, initialConversationId, backHref }: { persona: string; initialConversationId?: string; backHref?: string }) {
  const router = useRouter();
  const [step, setStep] = useState(initialConversationId ? 4 : 1);
  const [focus, setFocus] = useState<string>("AUTO");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [merges, setMerges] = useState<{ from: string; into: string }[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [uploader, setUploader] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [tone, setTone] = useState<"CASUAL" | "POLITE">("CASUAL");
  const [question, setQuestion] = useState("");
  const [mergePick, setMergePick] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadDetail = useCallback(async (id: string) => {
    const d = await api<Detail>(`/api/v1/conversations/${id}`);
    applyDetail(d);
  }, []);

  function applyDetail(d: Detail) {
    setDetail(d);
    setTitle(d.title ?? "");
    setFocus((f) => (f === "AUTO" && d.defaultFocus !== "AUTO" ? d.defaultFocus : f));
    setExcluded(new Set(d.participants.filter((p) => p.isBot || p.excluded).map((p) => p.participantId)));
    setMerges(d.participants.filter((p) => p.mergedIntoId).map((p) => ({ from: p.participantId, into: p.mergedIntoId! })));
    setUploader(d.uploaderParticipantId);
    setNames(Object.fromEntries(d.participants.map((p) => [p.participantId, p.displayName])));
  }

  useEffect(() => {
    if (initialConversationId) loadDetail(initialConversationId).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [initialConversationId, loadDetail]);

  const visibleParticipants = useMemo(() => (detail ? [...detail.participants].sort((a, b) => b.messageCount - a.messageCount) : []), [detail]);
  const mergedFrom = useMemo(() => new Set(merges.map((m) => m.from)), [merges]);
  const effectiveCount = visibleParticipants.filter((p) => !excluded.has(p.participantId) && !mergedFrom.has(p.participantId)).length;

  async function upload(files: FileList | File[]) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("files", f);
      if (focus !== "AUTO") form.append("focus", focus);
      const d = await api<Detail & { reused: boolean }>("/api/v1/conversations", { method: "POST", body: form });
      applyDetail(d);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "업로드에 실패했어요");
    } finally {
      setBusy(false);
    }
  }

  async function confirmAndCreate() {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/conversations/${detail.conversationId}/participants/confirm`, {
        method: "POST",
        body: JSON.stringify({
          uploaderParticipantId: uploader,
          merges,
          excluded: [...excluded].filter((id) => !mergedFrom.has(id)),
          displayNames: Object.fromEntries(Object.entries(names).filter(([, v]) => v.trim().length > 0)),
          title: title.trim() || undefined,
        }),
      });
      const r = await api<{ seq: number }>(`/api/v1/conversations/${detail.conversationId}/reports`, {
        method: "POST",
        body: JSON.stringify({ focus, tone, focusQuestion: question.trim() || null }),
      });
      router.push(`/c/${detail.conversationId}/story?then=${encodeURIComponent(`/c/${detail.conversationId}/reports/${r.seq}?show=writing`)}`);
    } catch (e) {
      setError(e instanceof ClientApiError ? `${e.message}${e.fieldErrors.length ? ` (${e.fieldErrors.map((f) => f.reason).join(", ")})` : ""}` : "요청에 실패했어요");
      setBusy(false);
    }
  }

  function toggleMergePick(id: string) {
    if (mergePick === null) {
      setMergePick(id);
      return;
    }
    if (mergePick === id) {
      setMergePick(null);
      return;
    }
    // 두 번째 선택: 메시지 많은 쪽을 대표로
    const a = visibleParticipants.find((p) => p.participantId === mergePick)!;
    const b = visibleParticipants.find((p) => p.participantId === id)!;
    const [from, into] = a.messageCount >= b.messageCount ? [b, a] : [a, b];
    setMerges((ms) => [...ms.filter((m) => m.from !== from.participantId && m.from !== into.participantId), { from: from.participantId, into: into.participantId }]);
    setMergePick(null);
  }

  const back = step > 1 ? () => setStep((s) => Math.max(1, s - 1)) : undefined;
  const next = () => setStep((s) => Math.min(TOTAL, s + 1));

  return (
    <div>
      <WizardHeader step={step} total={TOTAL} onBack={back} backHref={step === 1 ? (backHref ?? "/") : undefined} />
      {error && <div className="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {step === 1 && (
        <section>
          <h1 className="mb-6 text-2xl font-extrabold">{persona}한테 어떤 대화를 보여 줄까요?</h1>
          <div className="space-y-3">
            {TYPES.map((t) => (
              <button
                key={t.key}
                type="button"
                className="option-card"
                data-selected={focus === t.key}
                onClick={() => {
                  setFocus(t.key);
                  next();
                }}
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl text-3xl" style={{ background: t.bg }}>
                  {t.icon}
                </span>
                <span>
                  <span className="block text-lg font-bold">{t.title}</span>
                  <span className="block text-sm text-muted">{t.sub}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 2 && (
        <section>
          <h1 className="mb-6 text-2xl font-extrabold">어떤 앱에서 나눈 대화예요?</h1>
          <div className="space-y-3">
            {APPS.map((a) => (
              <button key={a.key} type="button" className="option-card disabled:opacity-50" disabled={!a.enabled} onClick={() => a.enabled && next()}>
                <span className="flex h-12 w-12 items-center justify-center rounded-xl text-xs font-extrabold" style={{ background: a.bg, color: a.fg }}>
                  {a.badge}
                </span>
                <span className="text-lg font-bold">{a.title}</span>
                {!a.enabled && <span className="ml-auto text-xs text-muted">곧 지원</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 3 && (
        <section>
          <h1 className="mb-6 text-2xl font-extrabold">카카오톡 대화 올리기</h1>
          <input ref={fileInput} type="file" accept=".txt,.csv,.zip,text/plain,text/csv,application/zip" multiple className="hidden" onChange={(e) => e.target.files && upload(e.target.files)} />
          {!detail ? (
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInput.current?.click()}
              onKeyDown={(e) => e.key === "Enter" && fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
              }}
              className="card flex aspect-square max-h-[520px] cursor-pointer flex-col items-center justify-center text-center"
            >
              {busy ? (
                <div className="text-lg font-semibold text-muted">읽는 중…</div>
              ) : (
                <>
                  <div className="text-6xl">📄</div>
                  <div className="mt-3 text-xl font-bold">눌러서 올리기</div>
                  <div className="text-sm text-muted">또는 끌어다 놓기</div>
                </>
              )}
              <details className="mt-10 text-xs text-muted" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                <summary className="cursor-pointer list-none">
                  🛡 올린 데이터는 비공개로 지켜져요 · <span className="underline">자세히 보기</span>
                </summary>
                <ul className="mx-auto mt-2 max-w-xs space-y-1 text-left">
                  <li>· 원문은 암호화(AES-256-GCM)해 저장하고 7일 뒤 자동 삭제돼요. 보고서는 직접 지우기 전까지 남아요.</li>
                  <li>· 보고서를 쓸 때만 대화가 AI 처리 위탁사(Anthropic, 미국)로 전송되고, 모델 학습에는 쓰이지 않아요.</li>
                  <li>· 전화번호·계좌번호 같은 패턴은 보내기 전에 가려요.</li>
                  <li>· 보고서는 기본 비공개예요. 공유 링크는 켜고 끌 수 있고, 대화·보고서는 언제든 삭제할 수 있어요.</li>
                  <li>
                    ·{" "}
                    <a href="/privacy" className="underline">
                      개인정보 처리 안내
                    </a>
                  </li>
                </ul>
              </details>
            </div>
          ) : (
            <div role="button" tabIndex={0} onClick={() => fileInput.current?.click()} onKeyDown={(e) => e.key === "Enter" && fileInput.current?.click()} className="glow-card flex aspect-square max-h-[520px] cursor-pointer flex-col items-center justify-center rounded-3xl text-center text-white shadow-lg">
              <div className="text-7xl font-black drop-shadow">{detail.messageCount.toLocaleString()}</div>
              <div className="text-xl font-semibold">메시지</div>
              <div className="mt-4 rounded-full bg-white px-4 py-1.5 text-sm font-bold text-emerald-700">📶 {detail.signal?.label ?? detail.tier0?.signalLabel ?? "신호 확인"}</div>
              <div className="mt-16 text-sm font-semibold opacity-90">눌러서 대화 바꾸기</div>
            </div>
          )}
          {detail?.signal && detail.signal.reasons.length > 0 && <p className="mt-3 text-center text-xs text-muted">{detail.signal.reasons.join(" · ")}</p>}
          <div className="mt-5 space-y-2 text-sm">
            <p>
              Windows용 카카오톡: 채팅방을 열고 <kbd className="rounded bg-gray-100 px-1.5">Ctrl</kbd> + <kbd className="rounded bg-gray-100 px-1.5">S</kbd> 를 눌러 파일을 저장하세요.
            </p>
            <p>Mac용 카카오톡: 채팅방을 열고 오른쪽 위 ≡ 버튼을 누른 다음, 채팅방 설정에서 대화 내용을 저장하세요.</p>
            <p className="text-muted">
              컴퓨터에는 최근 메시지만 있을 수 있어요. 대화 전체를 보내려면 📱{" "}
              <a href="/guide/export" className="underline">
                휴대폰에서 내보내 주세요
              </a>
            </p>
          </div>
          <button type="button" className="btn-primary mt-6" disabled={!detail || busy} onClick={next}>
            계속 →
          </button>
        </section>
      )}

      {step === 4 && detail && (
        <section>
          <div className="card mb-6 flex items-center gap-2 px-4 py-3">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="대화방 이름" className="flex-1 bg-transparent text-lg font-bold outline-none" maxLength={200} />
            <span className="text-muted">✎</span>
          </div>
          <div className="space-y-4">
            {visibleParticipants.map((p, i) => {
              const merged = mergedFrom.has(p.participantId);
              const ex = excluded.has(p.participantId);
              return (
                <div key={p.participantId} className={merged || ex ? "opacity-40" : ""}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 font-semibold">
                      <span className="inline-block h-3 w-3 rounded-full" style={{ background: colorFor(i) }} />
                      {p.rawName}
                      {p.isBot && <span className="rounded-full bg-gray-100 px-2 text-xs text-muted">봇</span>}
                      {merged && <span className="text-xs text-muted">→ {names[merges.find((m) => m.from === p.participantId)!.into] ?? "병합됨"}</span>}
                    </span>
                    <span className="text-muted">
                      {p.messageCount.toLocaleString()} 💬 <b className="text-ink">{Math.round((p.messageCount / Math.max(1, detail.messageCount)) * 100)}%</b>
                    </span>
                  </div>
                  <Bar pct={(p.messageCount / Math.max(1, visibleParticipants[0]?.messageCount ?? 1)) * 100} color={colorFor(i)} label="" right="" />
                  <div className="-mt-1 flex gap-3 text-xs text-muted">
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={ex} onChange={(e) => setExcluded((s) => { const n = new Set(s); if (e.target.checked) n.add(p.participantId); else n.delete(p.participantId); return n; })} /> 분석에서 제외
                    </label>
                    <label className="flex items-center gap-1">
                      <input type="radio" name="uploader" checked={uploader === p.participantId} onChange={() => setUploader(p.participantId)} disabled={ex || merged} /> 이게 나예요
                    </label>
                    {merged && (
                      <button type="button" className="underline" onClick={() => setMerges((ms) => ms.filter((m) => m.from !== p.participantId))}>
                        병합 취소
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="card mt-8 p-5">
            <h3 className="text-lg font-bold">한 사람은 한 번만 나오게 해 주세요</h3>
            <p className="mt-1 text-sm text-muted">한 사람이 다른 이름으로 여러 번 나오면, {persona}가 서로 다른 사람으로 착각해서 보고서를 잘못 쓸 수 있어요.</p>
            {detail.suggestedMerges.length > 0 && (
              <div className="mt-3 space-y-2">
                {detail.suggestedMerges.map((s) => {
                  const from = detail.participants.find((p) => p.participantId === s.from);
                  const into = detail.participants.find((p) => p.participantId === s.into);
                  const on = merges.some((m) => m.from === s.from && m.into === s.into);
                  return (
                    <label key={`${s.from}-${s.into}`} className="flex items-center gap-2 rounded-2xl bg-pastel-yellow px-3 py-2 text-sm text-[#6b4f00]">
                      <input type="checkbox" checked={on} onChange={(e) => setMerges((ms) => (e.target.checked ? [...ms.filter((m) => m.from !== s.from), { from: s.from, into: s.into }] : ms.filter((m) => !(m.from === s.from && m.into === s.into))))} />
                      「{from?.rawName}」와 「{into?.rawName}」는 같은 사람? <span className="opacity-60">(확신 {Math.round(s.confidence * 100)}%)</span>
                    </label>
                  );
                })}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {visibleParticipants
                .filter((p) => !mergedFrom.has(p.participantId) && !excluded.has(p.participantId))
                .map((p, i) => (
                  <button key={p.participantId} type="button" onClick={() => toggleMergePick(p.participantId)} className={`rounded-full border px-3 py-1 text-sm ${mergePick === p.participantId ? "border-ink bg-ink text-white" : "border-line"}`}>
                    <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: colorFor(i) }} />
                    {p.rawName}
                  </button>
                ))}
            </div>
            <p className="mt-2 text-xs text-muted">{mergePick ? "합칠 다른 이름을 하나 더 눌러 주세요. 메시지가 많은 쪽이 대표가 돼요." : "프로필 합치기: 같은 사람의 이름 두 개를 차례로 누르세요."}</p>
          </div>
          {effectiveCount < 2 && <p className="mt-4 text-sm text-red-600">분석할 참여자가 2명 이상 필요해요.</p>}
          <button type="button" className="btn-primary mt-6" disabled={effectiveCount < 2} onClick={next}>
            계속 →
          </button>
        </section>
      )}

      {step === 5 && detail && (
        <section>
          <h1 className="text-2xl font-extrabold">이름 정리하기</h1>
          <p className="mt-1 mb-6 text-sm text-muted">별명이랑 이모지는 간단한 이름으로 바꿔 주세요. 그래야 {persona}가 누가 누군지 알아요.</p>
          <div className="space-y-3">
            {visibleParticipants
              .filter((p) => !mergedFrom.has(p.participantId) && !excluded.has(p.participantId))
              .map((p, i) => (
                <div key={p.participantId} className="flex items-center gap-3">
                  <Avatar name={names[p.participantId] || p.rawName} color={colorFor(i)} size={44} />
                  <input value={names[p.participantId] ?? ""} onChange={(e) => setNames((n) => ({ ...n, [p.participantId]: e.target.value }))} maxLength={100} className="card flex-1 px-4 py-3 text-base outline-none" placeholder={p.rawName} />
                  {uploader === p.participantId && <span className="text-xs text-muted">(나)</span>}
                </div>
              ))}
          </div>
          <button type="button" className="btn-primary mt-6" onClick={next}>
            계속 →
          </button>
        </section>
      )}

      {step === 6 && (
        <section>
          <h1 className="text-2xl font-extrabold">보고서 언어를 골라 주세요</h1>
          <p className="mt-1 mb-6 text-sm text-muted">지금은 한국어만 돼요. 다른 언어는 준비 중이에요.</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {LANGS.map(([code, label, enabled]) => (
              <button key={code} type="button" disabled={!enabled} onClick={() => enabled && next()} className="option-card !gap-3 disabled:opacity-40" data-selected={enabled}>
                <span className="text-lg font-extrabold">{code}</span>
                <span className="font-semibold">{label}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 7 && detail && (
        <section>
          <h1 className="text-2xl font-extrabold">{persona}한테 보고서를 부탁할게요</h1>
          <p className="mt-1 mb-6 text-sm text-muted">통계 보고서는 바로 나오고, {persona}의 보고서는 보통 2~5분, 긴 대화는 최대 10분 걸려요. 이 브라우저에서만 열 수 있으니 링크를 잃어버리지 마세요.</p>
          <div className="space-y-4">
            <div className="card p-4">
              <div className="mb-2 text-sm font-bold">말투</div>
              <div className="flex gap-2">
                {(["CASUAL", "POLITE"] as const).map((t) => (
                  <button key={t} type="button" onClick={() => setTone(t)} className={`rounded-full border px-4 py-1.5 text-sm font-semibold ${tone === t ? "border-ink bg-ink text-white" : "border-line"}`}>
                    {t === "CASUAL" ? "반말 (기본)" : "존댓말"}
                  </button>
                ))}
              </div>
            </div>
            <div className="card p-4">
              <div className="mb-2 text-sm font-bold">{persona}한테 물어볼 것 (선택)</div>
              <textarea value={question} onChange={(e) => setQuestion(e.target.value.slice(0, 300))} rows={3} placeholder="예: 얘 나한테 관심 있는 거 맞아?" className="w-full resize-none rounded-2xl border border-line px-3 py-2 text-sm outline-none" />
              <div className="text-right text-xs text-muted">{question.length}/300</div>
            </div>
          </div>
          <button type="button" className="btn-primary mt-6" disabled={busy} onClick={confirmAndCreate}>
            {busy ? "보내는 중…" : "보고서 만들기 →"}
          </button>
        </section>
      )}
    </div>
  );
}
