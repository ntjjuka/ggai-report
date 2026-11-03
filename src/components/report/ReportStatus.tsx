"use client";
// 대기 화면(폴링) · 실패 화면 · 공유 컨트롤 — 클라이언트 조각
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ClientApiError } from "@/components/api";

interface View {
  reportId: string;
  status: string;
  progress: { stage: string | null; pct: number; message: string | null };
  error: { code: string; message: string; retryable: boolean } | null;
}

export function WritingScreen({ conversationId, seq, persona, initial, etaMinutes }: { conversationId: string; seq: number; persona: string; initial: View; etaMinutes: number }) {
  const router = useRouter();
  const [view, setView] = useState<View>(initial);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const v = await api<View>(`/api/v1/conversations/${conversationId}/reports/${seq}`);
        if (!alive) return;
        setView(v);
        if (v.status !== "QUEUED" && v.status !== "RUNNING") {
          router.refresh();
          return;
        }
      } catch {
        /* 일시 오류는 무시하고 다음 폴링 */
      }
      if (alive) timer = setTimeout(tick, 3000);
    };
    let timer = setTimeout(tick, 3000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [conversationId, seq, router]);

  const pct = Math.max(6, view.progress.pct);
  return (
    <div className="flex flex-col items-center py-16 text-center">
      <div className="relative">
        <div className="absolute inset-0 -m-10 rounded-full bg-[radial-gradient(circle,_#dbeafe_0%,_#fde2f3_40%,_transparent_70%)]" />
        <div className="relative flex h-40 w-40 items-center justify-center rounded-full bg-accent text-7xl shadow-lg">🧑‍💼</div>
        <div className="absolute -right-4 -top-2 rounded-2xl bg-white px-2 py-1 text-3xl shadow">🤔</div>
      </div>
      <h1 className="mt-10 text-xl font-bold text-muted">{persona}가 읽는 중…</h1>
      <div className="mt-4 h-3 w-72 overflow-hidden rounded-full bg-gray-200">
        <div className="progress-gradient h-full rounded-full transition-all duration-700" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-6 text-sm text-muted">{view.progress.message ?? `약 ${etaMinutes}분 걸려요.`}</p>
      {view.progress.stage === "SYNTH" && <p className="mt-1 text-xs text-muted">마지막 단계예요. 대화가 길면 이 단계에서 2~4분 머물러요. 진행률이 멈춘 것처럼 보여도 작성 중이에요.</p>}
      <p className="mt-1 text-xs text-muted">보통 {etaMinutes}분 안에 나와요. 이 페이지를 닫아도 "내 보고서"에서 다시 열 수 있어요.</p>
      <CancelReportButton reportId={view.reportId} />
    </div>
  );
}

function CancelReportButton({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="mt-8">
      <button
        type="button"
        className="text-xs text-muted underline"
        disabled={busy}
        onClick={async () => {
          if (!confirm("지금 만들고 있는 보고서를 취소할까요? 취소한 뒤 새 보고서를 만들 수 있어요.")) return;
          setBusy(true);
          setMsg(null);
          try {
            await api(`/api/v1/reports/${reportId}/cancel`, { method: "POST" });
            router.refresh();
          } catch (e) {
            setMsg(e instanceof ClientApiError ? e.message : "취소하지 못했어요");
            setBusy(false);
          }
        }}
      >
        너무 오래 걸리면 취소하기
      </button>
      {msg && <p className="mt-2 text-xs text-red-600">{msg}</p>}
    </div>
  );
}

export function FailedScreen({ reportId, persona, error }: { reportId: string; persona: string; error: { code: string; message: string; retryable: boolean } }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function retry() {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/v1/reports/${reportId}/retry`, { method: "POST" });
      router.refresh();
    } catch (e) {
      setMsg(e instanceof ClientApiError ? e.message : "다시 시도하지 못했어요");
      setBusy(false);
    }
  }
  return (
    <div className="card p-8 text-center">
      <div className="text-5xl">😮‍💨</div>
      <h1 className="mt-4 text-xl font-extrabold">{persona}가 보고서를 끝내지 못했어요</h1>
      <p className="mt-2 text-muted">{error.message}</p>
      <p className="mt-1 text-xs text-muted">오류 코드 {error.code}</p>
      {error.retryable && (
        <button type="button" className="btn-primary mt-6" disabled={busy} onClick={retry}>
          {busy ? "다시 줄 서는 중…" : "다시 시도"}
        </button>
      )}
      {msg && <p className="mt-3 text-sm text-red-600">{msg}</p>}
    </div>
  );
}

export function ShareControls({ reportId, conversationId, seq, initialEnabled }: { reportId: string; conversationId: string; seq: number; initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  async function enable() {
    setBusy(true);
    try {
      const r = await api<{ url: string }>(`/api/v1/reports/${reportId}/share/enable`, { method: "POST" });
      setUrl(r.url);
      setEnabled(true);
    } finally {
      setBusy(false);
    }
  }
  async function disable() {
    setBusy(true);
    try {
      await api(`/api/v1/reports/${reportId}/share/disable`, { method: "POST" });
      setUrl(null);
      setEnabled(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {enabled ? (
        <>
          {url ? (
            <button
              type="button"
              className="btn-secondary text-sm"
              onClick={async () => {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "복사됨 ✓" : "공유 링크 복사"}
            </button>
          ) : (
            <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={enable}>
              새 공유 링크 만들기
            </button>
          )}
          <button type="button" className="text-xs text-muted underline" disabled={busy} onClick={disable}>
            공유 끄기
          </button>
        </>
      ) : (
        <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={enable}>
          🔗 공유 링크 켜기
        </button>
      )}
      <a className="btn-secondary text-sm" href={`/setup?c=${conversationId}&back=${encodeURIComponent(`/c/${conversationId}/reports/${seq}`)}`}>
        새 보고서
      </a>
      <a className="text-xs text-muted underline" href={`/c/${conversationId}/story?then=${encodeURIComponent(`/c/${conversationId}/reports/${seq}`)}`}>
        통계 다시 보기
      </a>
    </div>
  );
}

export function DeleteConversationButton({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="text-sm text-red-600 underline"
      disabled={busy}
      onClick={async () => {
        if (!confirm("대화 원문, 통계, 보고서, 공유 링크가 모두 삭제돼요. 되돌릴 수 없어요. 삭제할까요?")) return;
        setBusy(true);
        try {
          await api(`/api/v1/conversations/${conversationId}`, { method: "DELETE" });
          router.push("/");
        } finally {
          setBusy(false);
        }
      }}
    >
      이 대화와 보고서 전부 삭제
    </button>
  );
}

export function DeleteReportButton({ reportId, conversationId }: { reportId: string; conversationId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className="text-xs text-red-600 underline"
        disabled={busy}
        onClick={async () => {
          if (!confirm("이 보고서만 삭제돼요. 대화 원문과 다른 보고서는 남아요. 삭제할까요?")) return;
          setBusy(true);
          setMsg(null);
          try {
            await api(`/api/v1/reports/${reportId}`, { method: "DELETE" });
            router.push(`/c/${conversationId}`);
          } catch (e) {
            setMsg(e instanceof ClientApiError ? e.message : "삭제하지 못했어요");
            setBusy(false);
          }
        }}
      >
        이 보고서 삭제
      </button>
      {msg && <span className="text-xs text-red-600">{msg}</span>}
    </span>
  );
}

export function NewReportForm({ conversationId, defaultFocus, persona }: { conversationId: string; defaultFocus: string; persona: string }) {
  const router = useRouter();
  const [focus, setFocus] = useState(defaultFocus);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const FOCUS = [
    ["AUTO", "자동"],
    ["ROMANCE", "연애"],
    ["FRIENDS_GROUP", "친구 단톡방"],
    ["FRIEND_ONE", "친구 한 명"],
    ["FAMILY", "가족"],
    ["WORK", "회사/팀"],
    ["OTHER", "기타"],
  ];
  return (
    <form
      className="card space-y-3 p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        try {
          const r = await api<{ seq: number }>(`/api/v1/conversations/${conversationId}/reports`, { method: "POST", body: JSON.stringify({ focus, focusQuestion: question.trim() || null }) });
          router.push(`/c/${conversationId}/reports/${r.seq}?show=writing`);
        } catch (err) {
          setMsg(err instanceof ClientApiError ? err.message : "요청에 실패했어요");
          setBusy(false);
        }
      }}
    >
      <h3 className="font-extrabold">{persona}한테 새 보고서 부탁하기</h3>
      <div className="flex flex-wrap gap-2">
        {FOCUS.map(([k, l]) => (
          <button key={k} type="button" onClick={() => setFocus(k)} className={`rounded-full border px-3 py-1 text-sm ${focus === k ? "border-ink bg-ink text-white" : "border-line"}`}>
            {l}
          </button>
        ))}
      </div>
      <textarea value={question} onChange={(e) => setQuestion(e.target.value.slice(0, 300))} rows={2} placeholder={`${persona}한테 물어볼 것 (선택)`} className="w-full resize-none rounded-2xl border border-line px-3 py-2 text-sm outline-none" />
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? "보내는 중…" : "보고서 만들기 →"}
      </button>
      {msg && <p className="text-sm text-red-600">{msg}</p>}
    </form>
  );
}
