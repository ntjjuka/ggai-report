// docs/08 §9 ASSEMBLE — 검증된 초안 + 통계 + 전사 → ReportContent
import { BADGE_BY_ID, assignRuleBadges } from "@/lib/tier0/badges";
import { SCORE_LABELS, type ScoreKey, type ScorePrior } from "@/lib/stats/priors";
import type { ChatStats } from "@/lib/stats/types";
import { pickShareEmoji, pickSignature } from "./moods";
import { DISCLAIMER, type Evidence, type Focus, type Mood, type ReportContent, type ReportDraft, type Tone } from "./schema";
import { maskText, type EvidenceIndex } from "./transcript";
import { collectInlineIds, mapProseStrings } from "./validator";

export interface AssembleContext {
  reportId: string;
  personaName: string;
  tone: Tone;
  mood: Mood;
  title: string;
  focus: Focus;
  question: string | null;
  participants: { id: string; name: string; isUploader: boolean }[];
  stats: ChatStats;
  priors: ScorePrior[];
  evidence: EvidenceIndex;
  plan: { mode: "SINGLE" | "CHUNKED"; coveragePct: number; chunksTotal: number; chunksSucceeded: number };
  metrics: { evidenceTotal: number; evidenceDropped: number; lowFindings: number; unverifiedNumbers: number; repaired: boolean };
  usage: { input: number; output: number; cacheRead: number; costUsd: number; durationSec: number; chunkModel: string | null; synthesisModel: string };
  generatedAt: string;
}

export function assembleReport(input: ReportDraft, ctx: AssembleContext): ReportContent {
  // 산문에 participantId(UUID)가 섞여 나오면 이름으로 바꾼다 (docs/07 §6). ID 전용 필드는 건드리지 않는다.
  const draft = mapProseStrings(input, (s) => {
    let out = s;
    for (const p of ctx.participants) if (out.includes(p.id)) out = out.split(p.id).join(p.name);
    return out;
  });
  const nameOf = (pid: string | null) => (pid ? ctx.participants.find((p) => p.id === pid)?.name ?? pid : null);
  const ev = (ids: string[]): Evidence[] =>
    ids
      .map((id) => ctx.evidence.get(id))
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map((m) => ({ messageId: m.id, participantId: m.pid, participantName: m.name, at: m.at, text: maskText(m.rawText).slice(0, 300) }));

  const isGroup = ctx.participants.length > 2;
  const resolvedFocus: ReportContent["meta"]["resolvedFocus"] =
    ctx.focus !== "AUTO" ? ctx.focus : isGroup ? "FRIENDS_GROUP" : /ROMAN|LOVE|CRUSH|DATING|SITU|COUPLE|FLIRT|SOME/i.test(draft.verdict.relationType.code) ? "ROMANCE" : "FRIEND_ONE";

  const ruleBadges = assignRuleBadges(ctx.stats);
  const awardNamesByPid = new Map<string, string[]>();
  for (const a of draft.awards) if (a.participantId) awardNamesByPid.set(a.participantId, [...(awardNamesByPid.get(a.participantId) ?? []), a.name]);

  const participants: ReportContent["participants"] = ctx.stats.perPerson
    .map((ps) => ctx.participants.find((p) => p.id === ps.id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => {
      const d = draft.participants.find((x) => x.participantId === p.id);
      const badgeIds = d && d.badgeIds.length ? d.badgeIds : ruleBadges.filter((b) => b.participantId === p.id).map((b) => b.badgeId);
      return {
        participantId: p.id,
        name: p.name,
        isUploader: p.isUploader,
        nickname: d?.nickname || p.name,
        role: d?.role ?? "",
        statement: d?.statement || "데이터가 부족해서 까비서가 판단을 보류했어. 숫자만 남긴다.",
        softLanding: d?.softLanding || "다음 보고서에서 다시 볼게.",
        badges: badgeIds.filter((id) => BADGE_BY_ID[id]).slice(0, 2).map((id) => ({ id, name: BADGE_BY_ID[id].name, icon: BADGE_BY_ID[id].icon })),
        awardNames: awardNamesByPid.get(p.id) ?? [],
        evidence: ev(d?.evidenceIds ?? []),
      };
    });

  const priorOf = (key: string) => ctx.priors.find((p) => p.key === key)?.prior ?? null;
  const scores: ReportContent["scores"] = draft.scores.map((s) => ({ ...s, label: SCORE_LABELS[s.key as ScoreKey] ?? s.key, prior: priorOf(s.key) }));
  // 누락 점수는 prior로 채운다 (docs/07 §6)
  for (const pr of ctx.priors) {
    if (draft.scores.length === 0) break;
    if (!scores.some((s) => s.key === pr.key)) scores.push({ key: pr.key, label: pr.label, value: pr.prior ?? 50, oneLiner: pr.prior === null ? "까비서가 이 항목은 숫자만 봤어." : `통계 기준 ${pr.prior}점. ${pr.basis}.`, confidence: "LOW", prior: pr.prior });
  }
  scores.sort((a, b) => ctx.priors.findIndex((p) => p.key === a.key) - ctx.priors.findIndex((p) => p.key === b.key));

  const initTotal = Object.values(ctx.stats.sessions.starts).reduce((a, b) => a + b, 0) || 1;
  const initiationShare: Record<string, number> = {};
  for (const p of ctx.stats.perPerson) initiationShare[p.id] = Math.round((p.initiations / initTotal) * 1000) / 1000;
  const replyLatency: Record<string, { medianSec: number | null; p90Sec: number | null }> = {};
  for (const p of ctx.stats.perPerson) replyLatency[p.id] = { medianSec: p.replyMedianSec, p90Sec: p.replyP90Sec };

  const inlineEvidence: Record<string, Evidence> = {};
  for (const e of ev(collectInlineIds(draft))) inlineEvidence[e.messageId] = e;

  const flags = [...new Set(draft.safetyFlags.filter((f) => f && f !== "NONE"))];
  const notice = safetyNotice(flags);

  return {
    schemaVersion: 1,
    persona: { name: ctx.personaName, tone: ctx.tone },
    mood: ctx.mood,
    meta: {
      title: ctx.title,
      focus: ctx.focus,
      resolvedFocus,
      period: { from: ctx.stats.period.startedAt.slice(0, 10), to: ctx.stats.period.endedAt.slice(0, 10), days: ctx.stats.period.days },
      messageCount: ctx.stats.total.messages,
      participants: ctx.participants,
      coveragePct: ctx.plan.coveragePct,
      generatedAt: ctx.generatedAt,
    },
    verdict: draft.verdict,
    dynamic: { paragraphs: draft.dynamic.paragraphs, groupRoles: draft.dynamic.groupRoles, evidence: ev(draft.dynamic.evidenceIds) },
    firstMove: {
      initiator: draft.firstMove.initiatorId ? { id: draft.firstMove.initiatorId, name: nameOf(draft.firstMove.initiatorId) ?? draft.firstMove.initiatorId } : null,
      pretender: draft.firstMove.pretenderId ? { id: draft.firstMove.pretenderId, name: nameOf(draft.firstMove.pretenderId) ?? draft.firstMove.pretenderId } : null,
      body: draft.firstMove.body,
      evidence: ev(draft.firstMove.evidenceIds),
    },
    privateLanguage: {
      phrases: draft.privateLanguage.phrases.map((p) => ({ phrase: p.phrase, meaning: p.meaning, evidence: ev(p.evidenceIds) })),
      runningJokes: draft.privateLanguage.runningJokes.map((j) => ({ title: j.title, summary: j.summary, evidence: ev(j.evidenceIds) })),
    },
    weekChanged: {
      exists: draft.weekChanged.exists,
      weekLabel: draft.weekChanged.weekLabel,
      weekStart: draft.weekChanged.weekStart,
      before: draft.weekChanged.before,
      after: draft.weekChanged.after,
      confidence: draft.weekChanged.confidence,
      pivot: draft.weekChanged.pivotMessageId ? ev([draft.weekChanged.pivotMessageId])[0] ?? null : null,
      evidence: ev(draft.weekChanged.evidenceIds),
    },
    participants,
    findings: draft.findings.map((f, i) => ({ id: i + 1, title: f.title, observed: f.observed, interpretation: f.interpretation, confidence: f.confidence, tags: f.tags, evidence: ev(f.evidenceIds) })),
    whatIWouldDo: draft.whatIWouldDo,
    awards: draft.awards.map((a) => ({ name: a.name, participantId: a.participantId, participantName: nameOf(a.participantId), reason: a.reason, evidence: ev(a.evidenceIds) })),
    scores,
    moments: draft.moments.map((m) => ({ kind: m.kind, caption: m.caption, messages: ev(m.messageIds) })).filter((m) => m.messages.length > 0),
    visuals: {
      monthly: ctx.stats.rhythm.monthly,
      heatmap: ctx.stats.rhythm.heatmap,
      replyLatency,
      initiationShare,
      media: { photo: ctx.stats.total.media.photo, video: ctx.stats.total.media.video, emoticon: ctx.stats.total.media.emoticon, voice: ctx.stats.total.media.voice, file: ctx.stats.total.media.file },
      captions: draft.visualCaptions,
    },
    answer: draft.answer && ctx.question ? { question: ctx.question, body: draft.answer.body, confidence: draft.answer.confidence, evidence: ev(draft.answer.evidenceIds) } : null,
    inlineEvidence,
    shareCard: { ...draft.shareCard, emoji: pickShareEmoji(ctx.reportId) },
    signature: pickSignature(ctx.reportId, ctx.participants.length),
    safety: { flags, notice },
    disclaimer: DISCLAIMER,
    quality: {
      mode: ctx.plan.mode,
      chunks: { total: ctx.plan.chunksTotal, succeeded: ctx.plan.chunksSucceeded },
      evidence: { total: ctx.metrics.evidenceTotal, dropped: ctx.metrics.evidenceDropped },
      lowFindings: ctx.metrics.lowFindings,
      repaired: ctx.metrics.repaired,
      unverifiedNumbers: ctx.metrics.unverifiedNumbers,
      models: { chunk: ctx.usage.chunkModel, synthesis: ctx.usage.synthesisModel },
      tokens: { input: ctx.usage.input, output: ctx.usage.output, cacheRead: ctx.usage.cacheRead },
      costUsd: Math.round(ctx.usage.costUsd * 10000) / 10000,
      durationSec: ctx.usage.durationSec,
    },
  };
}

function safetyNotice(flags: string[]): string | null {
  if (flags.includes("SELF_HARM")) return "대화에 힘든 신호가 보여서 까비서가 농담을 줄였어. 혼자 버티지 않아도 돼. 자살예방상담전화 109(24시간), 정신건강위기상담 1577-0199.";
  if (flags.includes("ABUSE") || flags.includes("VIOLENCE") || flags.includes("STALKING")) return "대화에 폭력·괴롭힘으로 보이는 신호가 있어서 그 부분은 농담 없이 다뤘어. 위험하다고 느끼면 112, 여성긴급전화 1366에 연락할 수 있어.";
  if (flags.includes("MINOR")) return "미성년자로 보이는 참여자가 있어서 연애 관련 표현을 줄였어.";
  return null;
}
