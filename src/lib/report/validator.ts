// docs/08 §8, docs/07 §6, docs/14 §6 — 초안 검증. 근거 접지·화자 일치·언어·금지 주제·점수 클램프·완전성.
import type { EvidenceIndex } from "./transcript";
import type { ReportDraft } from "./schema";

export interface ValidationContext {
  evidence: EvidenceIndex;
  participantIds: string[];
  isGroup: boolean;
  scoreKeys: string[];
  priors: Record<string, number | null>;
  scoresEnabled: boolean;
  allowedNumbers: Set<number>;
}

export type ViolationReason = "NON_KOREAN_SCRIPT" | "FORBIDDEN_TOPIC" | "NO_EVIDENCE" | "TOO_LONG" | "MISSING" | "BAD_ID" | "COUNSELOR_TONE";

export interface Violation {
  path: string;
  reason: ViolationReason;
  detail?: string;
}

export interface ValidationMetrics {
  evidenceTotal: number;
  evidenceDropped: number;
  lowFindings: number;
  unverifiedNumbers: number;
}

export interface ValidationResult {
  draft: ReportDraft;
  violations: Violation[];
  metrics: ValidationMetrics;
}

const NON_KOREAN_SCRIPT = /[一-鿿㐀-䶿぀-ヿ豈-﫿]/;
const FORBIDDEN = /뚱(?:뚱|보|땡)|못생|외모가|얼굴이\s?(?:별로|이상|못)|장애(?:인|자)?\b|정신병|우울증|조울증|ADHD|자살|죽어\s?버(?:려|리)|섹스|성관계|야한\s?(?:사진|얘기|영상)|흑인|동남아\s?(?:같|스럽)|게이\b|레즈|트랜스젠더|종교가\s?이상/;
const COUNSELOR = /전반적으로|긍정적인\s?관계|소통이\s?(?:잘|부족)|성향(?:이|으로)\s?보|노력이\s?필요|관계(?:는|로)\s?보입니다|인상적(?:이|인)|주목할\s?만한|흥미로운\s?(?:점|부분)|중요한\s?역할|다양한\s?주제/;
const TITLE_MAX = 60;
const TOPIC_MAX = 4;
const PARAGRAPH_MAX = 3;
const HEADLINE_MAX = 40;
const SUBLINE_MAX = 30;

export function validateDraft(input: ReportDraft, ctx: ValidationContext): ValidationResult {
  const draft: ReportDraft = structuredClone(input);
  const violations: Violation[] = [];
  const metrics: ValidationMetrics = { evidenceTotal: 0, evidenceDropped: 0, lowFindings: 0, unverifiedNumbers: 0 };
  const pidSet = new Set(ctx.participantIds);

  const keepIds = (ids: string[], speaker?: string | null): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      metrics.evidenceTotal += 1;
      const m = ctx.evidence.get(id);
      if (!m || (speaker && m.pid !== speaker)) {
        metrics.evidenceDropped += 1;
        continue;
      }
      if (!out.includes(id)) out.push(id);
    }
    return out.slice(0, 3);
  };

  // verdict
  if ([...draft.verdict.headline].length > HEADLINE_MAX) violations.push({ path: "verdict.headline", reason: "TOO_LONG", detail: `${HEADLINE_MAX}자 이내` });
  draft.verdict.body = draft.verdict.body.filter((p) => p.trim().length > 0).slice(0, 5);
  if (draft.verdict.body.length < 2) violations.push({ path: "verdict.body", reason: "MISSING", detail: "3~4문단" });

  // dynamic
  draft.dynamic.evidenceIds = keepIds(draft.dynamic.evidenceIds);
  draft.dynamic.paragraphs = draft.dynamic.paragraphs.filter((p) => p.trim()).slice(0, 4);
  const roles = draft.dynamic.groupRoles;
  const fixRole = (v: string | null) => (ctx.isGroup && v && pidSet.has(v) ? v : null);
  draft.dynamic.groupRoles = { holdsTogether: fixRole(roles.holdsTogether), goesQuiet: fixRole(roles.goesQuiet), runsTheShow: fixRole(roles.runsTheShow) };

  // firstMove / privateLanguage
  draft.firstMove.initiatorId = draft.firstMove.initiatorId && pidSet.has(draft.firstMove.initiatorId) ? draft.firstMove.initiatorId : null;
  draft.firstMove.pretenderId = draft.firstMove.pretenderId && pidSet.has(draft.firstMove.pretenderId) ? draft.firstMove.pretenderId : null;
  draft.firstMove.evidenceIds = keepIds(draft.firstMove.evidenceIds);
  draft.privateLanguage.phrases = draft.privateLanguage.phrases
    .slice(0, 5)
    .map((p) => ({ ...p, evidenceIds: keepIds(p.evidenceIds) }))
    .filter((p) => p.evidenceIds.length > 0 && p.phrase.trim().length > 0);
  draft.privateLanguage.runningJokes = draft.privateLanguage.runningJokes
    .slice(0, 4)
    .map((j) => ({ ...j, evidenceIds: keepIds(j.evidenceIds) }))
    .filter((j) => j.evidenceIds.length > 0);

  // weekChanged
  draft.weekChanged.evidenceIds = keepIds(draft.weekChanged.evidenceIds);
  if (draft.weekChanged.pivotMessageId && !ctx.evidence.has(draft.weekChanged.pivotMessageId)) {
    metrics.evidenceDropped += 1;
    draft.weekChanged.pivotMessageId = null;
  }
  if (draft.weekChanged.exists && !draft.weekChanged.before.includes("바뀐 주는")) {
    draft.weekChanged.before = `바뀐 주는 ${draft.weekChanged.weekLabel}다. ${draft.weekChanged.before}`.trim();
  }

  // participants — 인물 페르소나: 문단별 인용은 그 사람이 보낸 메시지만, 문단 0개면 MISSING(수리 대상)
  const seen = new Set<string>();
  draft.participants = draft.participants
    .filter((p) => pidSet.has(p.participantId) && !seen.has(p.participantId) && seen.add(p.participantId))
    .map((p) => ({
      ...p,
      emoji: firstGrapheme(p.emoji),
      title: clip(p.title, TITLE_MAX),
      nickname: p.nickname.trim(),
      type: { label: clip(p.type?.label ?? "", 20), description: clip(p.type?.description ?? "", 160) },
      topics: [...new Set((p.topics ?? []).map((t) => clip(t, 30)).filter(Boolean))].slice(0, TOPIC_MAX),
      paragraphs: (p.paragraphs ?? [])
        .map((par) => ({ text: (par.text ?? "").trim(), quoteIds: keepIds(par.quoteIds ?? [], p.participantId).slice(0, 2) }))
        .filter((par) => par.text.length > 0)
        .slice(0, PARAGRAPH_MAX),
      badgeIds: [...new Set(p.badgeIds)].slice(0, 2),
    }));
  draft.participants.forEach((p, i) => {
    if (p.paragraphs.length === 0) violations.push({ path: `participants[${i}].paragraphs`, reason: "MISSING", detail: `참여자 ${p.participantId} 문단 없음 — 1~3문단` });
  });
  for (const pid of ctx.participantIds) {
    if (!seen.has(pid)) violations.push({ path: `participants[${pid}]`, reason: "MISSING", detail: `참여자 ${pid} 항목 없음` });
  }

  // findings
  draft.findings = draft.findings.slice(0, 6).map((f) => ({ ...f, evidenceIds: keepIds(f.evidenceIds) }));
  draft.findings.forEach((f) => {
    if (f.evidenceIds.length === 0) {
      f.confidence = "LOW";
      metrics.lowFindings += 1;
    }
  });
  if (draft.findings.length < 3) violations.push({ path: "findings", reason: "MISSING", detail: "3~5개 필요" });
  if (metrics.lowFindings >= 3) violations.push({ path: "findings", reason: "NO_EVIDENCE", detail: `근거 없는 발견 ${metrics.lowFindings}개` });

  // whatIWouldDo
  draft.whatIWouldDo = draft.whatIWouldDo.slice(0, 3);
  if (draft.whatIWouldDo.length < 3) violations.push({ path: "whatIWouldDo", reason: "MISSING", detail: "정확히 3개" });

  // awards
  draft.awards = draft.awards.slice(0, 6).map((a) => ({ ...a, participantId: a.participantId && pidSet.has(a.participantId) ? a.participantId : null, evidenceIds: keepIds(a.evidenceIds) }));

  // scores
  if (!ctx.scoresEnabled) draft.scores = [];
  else {
    const byKey = new Map<string, ReportDraft["scores"][number]>();
    for (const s of draft.scores) if (ctx.scoreKeys.includes(s.key) && !byKey.has(s.key)) byKey.set(s.key, s);
    draft.scores = ctx.scoreKeys.filter((k) => byKey.has(k)).map((k) => {
      const s = byKey.get(k)!;
      let value = Math.max(0, Math.min(100, Math.round(s.value)));
      let confidence = s.confidence;
      const prior = ctx.priors[k];
      if (prior !== null && prior !== undefined && Math.abs(value - prior) > 40) {
        value = prior + Math.sign(value - prior) * 40;
        confidence = confidence === "HIGH" ? "MEDIUM" : "LOW";
      }
      return { ...s, value, confidence };
    });
    for (const k of ctx.scoreKeys) if (!byKey.has(k)) violations.push({ path: `scores[${k}]`, reason: "MISSING" });
  }

  // moments
  draft.moments = draft.moments
    .map((m) => ({ ...m, messageIds: keepIds(m.messageIds) }))
    .filter((m) => m.messageIds.length > 0)
    .slice(0, 8);

  // answer
  if (draft.answer) draft.answer.evidenceIds = keepIds(draft.answer.evidenceIds);

  // shareCard
  if ([...draft.shareCard.headline].length > HEADLINE_MAX) draft.shareCard.headline = draft.verdict.headline;
  if ([...draft.shareCard.subline].length > SUBLINE_MAX) draft.shareCard.subline = [...draft.shareCard.subline].slice(0, SUBLINE_MAX - 1).join("") + "…";

  // 언어·금지 주제·상담사 톤: 모든 문자열 필드 순회
  walkStrings(draft, (path, value) => {
    if (NON_KOREAN_SCRIPT.test(value)) violations.push({ path, reason: "NON_KOREAN_SCRIPT" });
    if (FORBIDDEN.test(value)) violations.push({ path, reason: "FORBIDDEN_TOPIC" });
    if (COUNSELOR.test(value) && (path.startsWith("verdict") || path.startsWith("dynamic") || path.startsWith("participants"))) violations.push({ path, reason: "COUNSELOR_TONE" });
  });

  // 숫자 소프트 검증 (품질 지표만)
  metrics.unverifiedNumbers = countUnverifiedNumbers([...draft.verdict.body, ...draft.dynamic.paragraphs, ...draft.findings.map((f) => f.observed)], ctx.allowedNumbers);
  if ([...draft.verdict.reportTitle].length > TITLE_MAX) draft.verdict.reportTitle = clip(draft.verdict.reportTitle, TITLE_MAX);

  // 산문 속 인라인 메시지 ID("그런데 m8812를 봐"): 전사에 없는 ID는 제거하고 dropped로 센다 (docs/18 §4, docs/07 §6)
  const scrubbed = scrubInlineIds(draft, (id) => ctx.evidence.has(id), (ok) => {
    metrics.evidenceTotal += 1;
    if (!ok) metrics.evidenceDropped += 1;
  });

  return { draft: scrubbed, violations: dedupeViolations(violations), metrics };
}

function clip(s: string, max: number): string {
  const t = (s ?? "").trim();
  const chars = [...t];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : t;
}

/** 첫 글자(이모지 1개). 비어 있으면 기본 이모지 */
export function firstGrapheme(s: string): string {
  const t = (s ?? "").trim();
  if (!t) return "🙂";
  const seg = typeof Intl !== "undefined" && "Segmenter" in Intl ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t)][0]?.segment : undefined;
  return seg ?? [...t][0];
}

const INLINE_ID_TEST = /\bm\d+\b/;
const ID_KEY_RE = /(?:Ids?|Id)$|^(?:repairedBy|holdsTogether|goesQuiet|runsTheShow)$/;

/** 산문 필드의 m123 토큰을 검사한다. ID 전용 키(…Ids, …Id)는 건너뛴다. 없는 ID는 지우고 주변 공백·빈 괄호를 정리한다. */
export function scrubInlineIds<T>(obj: T, has: (id: string) => boolean, onToken: (ok: boolean) => void): T {
  const visit = (v: unknown, key: string): unknown => {
    if (typeof v === "string") {
      if (ID_KEY_RE.test(key) || !INLINE_ID_TEST.test(v)) return v;
      const out = v.replace(/\bm\d+\b/g, (id) => {
        const ok = has(id);
        onToken(ok);
        return ok ? id : "";
      });
      return out
        .replace(/\(\s*\)/g, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s+([,.!?])/g, "$1")
        .trim();
    }
    if (Array.isArray(v)) return v.map((x) => visit(x, key));
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = visit(x, k);
      return o;
    }
    return v;
  };
  return visit(obj, "") as T;
}

/** ID 전용 키를 제외한 모든 문자열 필드에 fn을 적용한 사본 */
export function mapProseStrings<T>(obj: T, fn: (value: string, key: string) => string): T {
  const visit = (v: unknown, key: string): unknown => {
    if (typeof v === "string") return ID_KEY_RE.test(key) ? v : fn(v, key);
    if (Array.isArray(v)) return v.map((x) => visit(x, key));
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = visit(x, k);
      return o;
    }
    return v;
  };
  return visit(obj, "") as T;
}

/** 산문 속 인라인 ID 목록 (ID 전용 키 제외, 등장 순서, 중복 제거) */
export function collectInlineIds(obj: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown, key: string) => {
    if (typeof v === "string") {
      if (ID_KEY_RE.test(key)) return;
      for (const m of v.matchAll(/\bm\d+\b/g)) if (!out.includes(m[0])) out.push(m[0]);
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) visit(x, k);
  };
  visit(obj, "");
  return out;
}

/** 위반 path 단위로 초안에 패치 적용 (REPAIR 결과). null 패치는 배열 원소 삭제. */
export function applyPatches(draft: ReportDraft, patches: { path: string; valueJson: string }[]): ReportDraft {
  const out: ReportDraft = structuredClone(draft);
  const deletions: { arr: unknown[]; idx: number }[] = [];
  for (const p of patches) {
    let value: unknown;
    try {
      value = JSON.parse(p.valueJson);
    } catch {
      continue;
    }
    const tokens = p.path.match(/[^.[\]]+/g) ?? [];
    if (tokens.length === 0) continue;
    let target: unknown = out;
    for (let i = 0; i < tokens.length - 1; i++) {
      if (target === null || typeof target !== "object") {
        target = undefined;
        break;
      }
      target = (target as Record<string, unknown>)[tokens[i]];
    }
    if (target === null || typeof target !== "object") continue;
    const last = tokens[tokens.length - 1];
    if (Array.isArray(target)) {
      const idx = Number(last);
      if (!Number.isInteger(idx) || idx < 0 || idx >= target.length) continue;
      if (value === null) deletions.push({ arr: target, idx });
      else target[idx] = value;
    } else {
      (target as Record<string, unknown>)[last] = value;
    }
  }
  for (const d of deletions.sort((a, b) => b.idx - a.idx)) d.arr.splice(d.idx, 1);
  return out;
}

/** 수리 후에도 남은 위반을 강제 정리 (필드 제거·절단) */
export function enforceFinal(draft: ReportDraft, violations: Violation[]): ReportDraft {
  const out: ReportDraft = structuredClone(draft);
  const removeFinding = new Set<number>();
  const removeMoment = new Set<number>();
  const removeAward = new Set<number>();
  for (const v of violations) {
    if (v.reason !== "NON_KOREAN_SCRIPT" && v.reason !== "FORBIDDEN_TOPIC" && v.reason !== "COUNSELOR_TONE" && v.reason !== "TOO_LONG") continue;
    let m: RegExpMatchArray | null;
    if ((m = v.path.match(/^findings\[(\d+)\]/))) removeFinding.add(Number(m[1]));
    else if ((m = v.path.match(/^moments\[(\d+)\]/))) removeMoment.add(Number(m[1]));
    else if ((m = v.path.match(/^awards\[(\d+)\]/))) removeAward.add(Number(m[1]));
    else if ((m = v.path.match(/^verdict\.body\[(\d+)\]/))) out.verdict.body[Number(m[1])] = "";
    else if ((m = v.path.match(/^dynamic\.paragraphs\[(\d+)\]/))) out.dynamic.paragraphs[Number(m[1])] = "";
    else if ((m = v.path.match(/^participants\[(\d+)\]\.paragraphs\[(\d+)\]/))) {
      const p = out.participants[Number(m[1])];
      if (p?.paragraphs[Number(m[2])]) p.paragraphs[Number(m[2])] = { text: "", quoteIds: [] };
    } else if ((m = v.path.match(/^participants\[(\d+)\]\.topics\[(\d+)\]/))) {
      const p = out.participants[Number(m[1])];
      if (p) p.topics[Number(m[2])] = "";
    } else if ((m = v.path.match(/^participants\[(\d+)\]\.(\w+)/))) {
      const p = out.participants[Number(m[1])];
      if (p) {
        if (m[2] === "title") p.title = "";
        if (m[2] === "nickname") p.nickname = "";
        if (m[2] === "type") p.type = { label: "", description: "" };
        if (m[2] === "emoji") p.emoji = "🙂";
      }
    } else if (v.path === "verdict.reportTitle") out.verdict.reportTitle = ""; else if (v.path === "verdict.headline") out.verdict.headline = [...out.verdict.headline].slice(0, HEADLINE_MAX - 1).join("") + "…";
    else if ((m = v.path.match(/^whatIWouldDo\[(\d+)\]/))) out.whatIWouldDo[Number(m[1])] = { title: "보류", body: "내가 너라면 이 항목은 다음 보고서로 넘긴다.", deadline: "다음 보고서" };
    else if (v.path.startsWith("shareCard")) out.shareCard = { headline: out.verdict.headline, subline: "" };
    else if (v.path.startsWith("answer") && out.answer) out.answer = { ...out.answer, body: "질문에 대한 답은 검토 중 제외됐어. 다시 생성해 봐." };
    else if (v.path.startsWith("weekChanged")) {
      out.weekChanged.before = out.weekChanged.before.replace(NON_KOREAN_SCRIPT, "");
      out.weekChanged.after = out.weekChanged.after.replace(NON_KOREAN_SCRIPT, "");
    } else if ((m = v.path.match(/^privateLanguage\.phrases\[(\d+)\]/))) out.privateLanguage.phrases.splice(Number(m[1]), 1, { phrase: "", meaning: "", evidenceIds: [] });
    else if ((m = v.path.match(/^privateLanguage\.runningJokes\[(\d+)\]/))) out.privateLanguage.runningJokes.splice(Number(m[1]), 1, { title: "", summary: "", evidenceIds: [] });
    else if (v.path.startsWith("firstMove")) out.firstMove = { ...out.firstMove, body: "" };
  }
  out.privateLanguage.phrases = out.privateLanguage.phrases.filter((p) => p.phrase);
  out.privateLanguage.runningJokes = out.privateLanguage.runningJokes.filter((j) => j.title);
  out.findings = out.findings.filter((_, i) => !removeFinding.has(i));
  out.moments = out.moments.filter((_, i) => !removeMoment.has(i));
  out.awards = out.awards.filter((_, i) => !removeAward.has(i));
  out.verdict.body = out.verdict.body.filter((p) => p.length > 0);
  out.dynamic.paragraphs = out.dynamic.paragraphs.filter((p) => p.length > 0);
  for (const p of out.participants) {
    p.paragraphs = p.paragraphs.filter((par) => par.text.length > 0);
    p.topics = p.topics.filter(Boolean);
  }
  return out;
}

export function walkStrings(obj: unknown, visit: (path: string, value: string) => void, path = ""): void {
  if (typeof obj === "string") {
    visit(path, obj);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walkStrings(v, visit, `${path}[${i}]`));
    return;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) walkStrings(v, visit, path ? `${path}.${k}` : k);
  }
}

function dedupeViolations(vs: Violation[]): Violation[] {
  const seen = new Set<string>();
  return vs.filter((v) => {
    const k = `${v.path}|${v.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 날짜·시각·ID·백분율 맥락을 제외한 10 이상의 정수 중 허용 집합에 없는 개수 */
export function countUnverifiedNumbers(texts: string[], allowed: Set<number>): number {
  let n = 0;
  for (const t of texts) {
    const cleaned = t
      .replace(/m\d+/g, " ")
      .replace(/\d{4}년|\d{1,2}월|\d{1,2}일|\d{1,2}시|\d{1,2}:\d{2}|\d{4}-\d{2}(-\d{2})?/g, " ");
    for (const m of cleaned.matchAll(/\d+(?:\.\d+)?/g)) {
      const v = Number(m[0]);
      if (v >= 10 && !allowed.has(v)) n += 1;
    }
  }
  return n;
}
