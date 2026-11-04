// docs/08 §3 결정적 통계 계산기 (statsVersion 1)
import type { Message } from "@/lib/parser/types";
import { isBlobLike } from "@/lib/parser/patterns";
import { MEDIA_KINDS, SYSTEM_KINDS } from "@/lib/parser/types";
import { atToMs, dateKey, hourOf, monthKey, weekKey, weekdayOf, daysBetween } from "./time";
import { SESSION_GAP_HOURS, type ChatStats, type EffectiveParticipant, type FunFacts, type ParticipantMap, type PersonStat } from "./types";

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const LAUGH_RE = /[ㅋㅎ]/g;
const GAP_MS = SESSION_GAP_HOURS * 3600_000;
const FAST_REPLY_SEC = 60;
const LAUGH_RUN_RE = /ㅋ{2,}/g;
const WORD_RE = /[가-힣]{2,8}/g;
// 가장 많이 쓴 단어·말버릇에서 제외할 흔한 말 (조사·감탄·대명사 등)
const STOPWORDS = new Set(["그냥", "진짜", "근데", "그래", "아니", "오늘", "내일", "지금", "이거", "저거", "그거", "우리", "너무", "그럼", "그리고", "그런데", "하는", "하고", "해서", "있는", "없는", "같은", "이제", "다시", "먼저", "정말", "완전", "그게", "이게", "저게", "뭐야", "뭐지", "뭐해", "어디", "언제", "누구", "어떻게", "왜냐면", "일단", "혹시", "약간", "조금", "많이", "다들", "모두", "여기", "거기", "저기", "사진", "이모티콘", "동영상", "삭제된", "메시지입니다", "메시지가", "삭제되었습니다", "안녕", "안녕하세요", "감사합니다", "넵", "네네", "아니요", "아니야", "맞아", "그치", "그래서", "하지만", "그러면", "그러니까", "때문에", "있어", "없어", "같아", "해야", "할게", "했어", "했다", "한다", "된다", "되는", "이런", "저런", "그런", "뭔가", "오케이", "오키", "어제", "요즘", "이번", "다음", "지난", "하나", "둘이", "셋이", "사람", "생각", "시간", "정도", "경우", "자기", "저희", "제가", "내가", "네가", "니가", "나도", "너도", "우리가", "우리는", "나는", "너는"]);
// 일반 한국어 채팅 기준 빈도(메시지 1만 개당 대략치). 없는 단어는 희귀어로 본다.
const BASELINE_PER_10K: Record<string, number> = { 대박: 25, 미친: 20, 헐: 60, 와: 80, 아니: 150, 진짜: 200, 개: 40, 존나: 15, 존맛: 2, 맛있: 20, 배고파: 15, 졸려: 15, 피곤: 12, 사랑: 10, 보고싶: 8, 귀여: 15, 예쁘: 12, 멋있: 6, 화이팅: 10, 파이팅: 8, 굿: 20, 오케이: 20, 콜: 15, 가즈아: 3, 레전드: 5, 미쳤다: 10, 실화: 6, 인정: 15, 공감: 5, 좋아: 80, 싫어: 20, 몰라: 40, 알았어: 40, 알겠어: 30, 고마워: 20, 미안: 25, 축하: 10, 생일: 8, 치킨: 10, 커피: 15, 술: 15, 맥주: 8, 소주: 6, 회사: 25, 학교: 15, 집: 60, 잠: 20, 야: 100, 넹: 15, 넴: 2, 옹: 5, 웅: 20, 응: 120, 엉: 8 };
// 서로를 부르는 말(호칭): 단어 경계 근사. 뒤에 호격·복수 접미(야/아/님/들/들아)와 문장부호 허용
const VOCATIVE_TERMS = ["언니", "오빠", "누나", "형", "형님", "누님", "자기", "여보", "애기", "엄마", "아빠", "아들", "딸", "이모", "삼촌", "선배", "후배", "쌤", "샘", "사장님", "팀장님", "과장님", "대리님", "부장님", "얘들아", "애들아", "여러분", "친구야", "동생", "베프"];
const VOCATIVE_RE = new RegExp(`(?:^|[\\s,!?~.])(${VOCATIVE_TERMS.join("|")})(?:야|아|들|들아|님)?(?=$|[\\s,!?~.ㅋㅎ])`, "g");

/** 통계·전사 공용: 매핑된 유효 메시지 (시스템·봇·제외 참여자 제거) */
export interface EffectiveMessage {
  index: number;
  at: string;
  ms: number;
  pid: string;
  kind: Message["kind"];
  text: string;
  hasLink: boolean;
  mentions: string[];
  /** 직전 유효 메시지와 이 메시지 사이에 제외 참여자/시스템 메시지가 n개 있었음 (답장 추정 차단) */
  contextBreakBefore: number;
}

export function toEffectiveMessages(messages: Message[], map: ParticipantMap): EffectiveMessage[] {
  const out: EffectiveMessage[] = [];
  let skippedSinceLast = 0;
  for (const m of messages) {
    if (m.sender === null || m.kind === "BOT" || SYSTEM_KINDS.has(m.kind)) {
      if (m.sender !== null && m.kind === "BOT") skippedSinceLast += 1;
      continue;
    }
    const p = map.get(m.sender);
    if (!p) {
      skippedSinceLast += 1;
      continue;
    }
    out.push({
      index: m.index,
      at: m.at,
      ms: atToMs(m.at),
      pid: p.id,
      kind: m.kind === "TEXT" && isBlobLike(m.text) ? "DATA" : m.kind, // 구버전 업로드(덩어리가 TEXT로 저장됨) 호환
      text: m.text,
      hasLink: m.hasLink,
      mentions: m.mentions,
      contextBreakBefore: skippedSinceLast,
    });
    skippedSinceLast = 0;
  }
  return out;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}

function count(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

export function computeStats(messages: Message[], map: ParticipantMap, uploaderId: string | null): ChatStats {
  const participants = [...new Map([...map.values()].map((p) => [p.id, p])).values()];
  const eff = toEffectiveMessages(messages, map);
  const systemEvents = messages.filter((m) => SYSTEM_KINDS.has(m.kind)).length;

  const per = new Map<string, PersonStat>();
  const latency = new Map<string, number[]>();
  const emojiCounts = new Map<string, Map<string, number>>();
  const vocatives = new Map<string, Map<string, number>>();
  const wordCounts = new Map<string, number>();
  const personWords = new Map<string, Map<string, number>>();
  const emojiTotals = new Map<string, number>();
  let longestLaughRun: { id: string; len: number; index: number } | null = null;
  const lastSeen = new Map<string, number>();
  const consecutive = new Map<string, { runs: number; total: number }>();
  const ensure = (p: EffectiveParticipant) => {
    if (!per.has(p.id)) {
      per.set(p.id, {
        id: p.id,
        name: p.name,
        messages: 0,
        textMessages: 0,
        chars: 0,
        avgLen: 0,
        share: 0,
        initiations: 0,
        replyCount: 0,
        replyMedianSec: null,
        replyP90Sec: null,
        emoticons: 0,
        photos: 0,
        laughs: 0,
        questions: 0,
        exclaims: 0,
        lateNight: 0,
        links: 0,
        mentionsMade: 0,
        longestMessageIndex: null,
        longestMessageLen: 0,
        sessionEnds: 0,
        focusWords: [],
        longestSilentDays: 0,
        fastReplyRate: null,
        vocative: null,
      });
      latency.set(p.id, []);
      emojiCounts.set(p.id, new Map());
      consecutive.set(p.id, { runs: 0, total: 0 });
    }
  };
  participants.forEach(ensure);

  const total = {
    messages: eff.length,
    textMessages: 0,
    media: { photo: 0, video: 0, emoticon: 0, voice: 0, file: 0, other: 0 },
    deleted: 0,
    links: 0,
    systemEvents,
  };
  const heatmap: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const monthly = new Map<string, { month: string; total: number; perPerson: Record<string, number> }>();
  const weekly = new Map<string, number>();
  const dayCounts = new Map<string, number>();
  const sessionStarts: Record<string, number> = {};
  const sessionEnds: Record<string, number> = {};
  let sessionCount = 0;
  let sessionLenSum = 0;
  let curSessionLen = 0;
  let maxGap = -1;
  let silenceIdx = -1;
  let runPid: string | null = null;
  let runLen = 0;

  for (let i = 0; i < eff.length; i++) {
    const m = eff[i];
    const p = per.get(m.pid)!;
    p.messages += 1;
    if (m.kind === "TEXT") {
      p.textMessages += 1;
      total.textMessages += 1;
      p.chars += m.text.length;
      p.laughs += count(m.text, LAUGH_RE);
      p.questions += count(m.text, /\?/g);
      p.exclaims += count(m.text, /!/g);
      p.mentionsMade += m.mentions.length;
      if (m.text.length > p.longestMessageLen) {
        p.longestMessageLen = m.text.length;
        p.longestMessageIndex = m.index;
      }
      for (const ch of m.text.match(EMOJI_RE) ?? []) {
        const ec = emojiCounts.get(m.pid)!;
        ec.set(ch, (ec.get(ch) ?? 0) + 1);
        emojiTotals.set(ch, (emojiTotals.get(ch) ?? 0) + 1);
      }
      for (const run of m.text.match(LAUGH_RUN_RE) ?? []) {
        if (!longestLaughRun || run.length > longestLaughRun.len) longestLaughRun = { id: m.pid, len: run.length, index: m.index };
      }
      for (const w of m.text.match(WORD_RE) ?? []) {
        if (STOPWORDS.has(w)) continue;
        wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
        const pw = personWords.get(m.pid) ?? new Map<string, number>();
        pw.set(w, (pw.get(w) ?? 0) + 1);
        personWords.set(m.pid, pw);
      }
      for (const vm of m.text.matchAll(VOCATIVE_RE)) {
        const vc = vocatives.get(m.pid) ?? new Map<string, number>();
        vc.set(vm[1], (vc.get(vm[1]) ?? 0) + 1);
        vocatives.set(m.pid, vc);
      }
    } else if (m.kind === "PHOTO") {
      p.photos += 1;
      total.media.photo += 1;
    } else if (m.kind === "EMOTICON") {
      p.emoticons += 1;
      total.media.emoticon += 1;
    } else if (m.kind === "VIDEO") total.media.video += 1;
    else if (m.kind === "VOICE") total.media.voice += 1;
    else if (m.kind === "FILE") total.media.file += 1;
    else if (m.kind === "DELETED") total.deleted += 1;
    else if (MEDIA_KINDS.has(m.kind)) total.media.other += 1;
    if (m.hasLink) {
      p.links += 1;
      total.links += 1;
    }
    const hour = hourOf(m.at);
    if (hour < 5) p.lateNight += 1;
    heatmap[weekdayOf(m.at)][hour] += 1;
    const mk = monthKey(m.at);
    const mv = monthly.get(mk) ?? { month: mk, total: 0, perPerson: {} };
    mv.total += 1;
    mv.perPerson[m.pid] = (mv.perPerson[m.pid] ?? 0) + 1;
    monthly.set(mk, mv);
    const wk = weekKey(m.at);
    weekly.set(wk, (weekly.get(wk) ?? 0) + 1);
    const dk = dateKey(m.at);
    dayCounts.set(dk, (dayCounts.get(dk) ?? 0) + 1);

    // 세션/선톡/답장
    const prev = i > 0 ? eff[i - 1] : null;
    const gap = prev ? m.ms - prev.ms : Infinity;
    if (!prev || gap >= GAP_MS) {
      p.initiations += 1;
      sessionStarts[m.pid] = (sessionStarts[m.pid] ?? 0) + 1;
      if (prev) {
        sessionEnds[prev.pid] = (sessionEnds[prev.pid] ?? 0) + 1;
        per.get(prev.pid)!.sessionEnds += 1;
        sessionLenSum += curSessionLen;
      }
      sessionCount += 1;
      curSessionLen = 1;
    } else {
      curSessionLen += 1;
      if (prev && prev.pid !== m.pid && m.contextBreakBefore === 0 && gap >= 0) {
        latency.get(m.pid)!.push(gap / 1000);
        p.replyCount += 1;
      }
    }
    if (prev && m.contextBreakBefore === 0 && gap > maxGap) {
      maxGap = gap;
      silenceIdx = i;
    }
    // 연속 발화
    if (runPid === m.pid) runLen += 1;
    else {
      if (runPid) {
        const c = consecutive.get(runPid)!;
        c.runs += 1;
        c.total += runLen;
      }
      runPid = m.pid;
      runLen = 1;
    }
    // 개인 최장 침묵
    const seen = lastSeen.get(m.pid);
    if (seen !== undefined) {
      const silentDays = Math.floor((m.ms - seen) / 86_400_000);
      if (silentDays > p.longestSilentDays) p.longestSilentDays = silentDays;
    }
    lastSeen.set(m.pid, m.ms);
  }
  if (runPid) {
    const c = consecutive.get(runPid)!;
    c.runs += 1;
    c.total += runLen;
  }
  if (eff.length > 0) {
    sessionLenSum += curSessionLen;
    const last = eff[eff.length - 1];
    sessionEnds[last.pid] = (sessionEnds[last.pid] ?? 0) + 1;
    per.get(last.pid)!.sessionEnds += 1;
  }

  const totalTextForShare = [...per.values()].reduce((a, p) => a + p.textMessages, 0);
  for (const p of per.values()) {
    p.avgLen = p.textMessages ? Math.round((p.chars / p.textMessages) * 10) / 10 : 0;
    p.share = totalTextForShare ? Math.round((p.textMessages / totalTextForShare) * 1000) / 1000 : 0; // 텍스트 기준 (첨부 제외)
    const lat = latency.get(p.id)!;
    p.replyMedianSec = median(lat);
    p.replyP90Sec = percentile(lat, 0.9);
    p.fastReplyRate = lat.length ? Math.round((lat.filter((x) => x <= FAST_REPLY_SEC).length / lat.length) * 1000) / 1000 : null;
    const vc = vocatives.get(p.id);
    if (vc) {
      let best: { term: string; count: number } | null = null;
      for (const [term, count] of vc) if (count >= 3 && (!best || count > best.count)) best = { term, count };
      p.vocative = best;
    }
  }

  const startedAt = eff[0]?.at ?? "1970-01-01T00:00";
  const endedAt = eff[eff.length - 1]?.at ?? startedAt;

  const funFacts = computeFunFacts(eff, per, emojiCounts, heatmap, dayCounts, maxGap, silenceIdx);
  const names = new Set([...per.values()].flatMap((p) => [p.name, ...(participants.find((x) => x.id === p.id)?.rawNames ?? [])]));
  const wordEntries = [...wordCounts.entries()].filter(([w]) => !names.has(w)).sort((a, b) => b[1] - a[1]);
  funFacts.topWords = wordEntries.slice(0, 5).map(([word, count]) => ({ word, count }));
  // 사람별 집중 단어: 본인이 3번 이상 썼고, 방 전체 사용량 중 본인 몫이 큰 단어(관심사 힌트). 점수 = 횟수 × 집중도
  for (const [pid, pw] of personWords) {
    const stat = per.get(pid);
    if (!stat) continue;
    stat.focusWords = [...pw.entries()]
      .filter(([w, c]) => c >= 3 && !names.has(w))
      .map(([word, count]) => ({ word, count, total: wordCounts.get(word) ?? count }))
      .sort((a, b) => b.count * (b.count / b.total) - a.count * (a.count / a.total) || b.count - a.count)
      .slice(0, 6);
  }
  const per10k = (c: number) => (c / Math.max(1, total.textMessages)) * 10_000;
  funFacts.verbalTics = wordEntries
    .filter(([w, c]) => c >= 2 && w.length <= 6)
    .map(([word, count]) => ({ word, count, ratio: per10k(count) / (BASELINE_PER_10K[word] ?? 0.5) }))
    .filter((x) => x.ratio >= 3)
    .sort((a, b) => b.ratio - a.ratio || b.count - a.count)
    .slice(0, 3)
    .map((x) => ({ ...x, ratio: Math.round(x.ratio) }));
  funFacts.topEmojis = [...emojiTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([emoji, count]) => ({ emoji, count }));
  funFacts.laughRanking = [...per.values()].filter((p) => p.laughs > 0).sort((a, b) => b.laughs - a.laughs).slice(0, 5).map((p) => ({ id: p.id, count: p.laughs }));
  funFacts.longestLaughRun = longestLaughRun;
  const emoTotal = [...per.values()].reduce((a, p) => a + p.emoticons, 0);
  funFacts.emoticonShare = Object.fromEntries([...per.values()].map((p) => [p.id, emoTotal ? Math.round((p.emoticons / emoTotal) * 1000) / 1000 : 0]));
  const hourly = Array.from({ length: 24 }, (_, h) => heatmap.reduce((a, row) => a + row[h], 0));
  const nightCount = hourly.slice(22).reduce((a, b) => a + b, 0) + hourly.slice(0, 5).reduce((a, b) => a + b, 0);
  const peakHour = hourly.indexOf(Math.max(...hourly));
  const avgConsecutive: Record<string, number> = {};
  for (const [pid, c] of consecutive) avgConsecutive[pid] = c.runs ? Math.round((c.total / c.runs) * 100) / 100 : 0;

  const perPerson = [...per.values()].sort((a, b) => b.textMessages - a.textMessages || b.messages - a.messages);
  const balance = computeBalance(perPerson, uploaderId);

  return {
    statsVersion: 1,
    total,
    period: { startedAt, endedAt, days: Math.max(0, daysBetween(startedAt, endedAt)), activeDays: dayCounts.size },
    perPerson,
    sessions: {
      count: sessionCount,
      avgLenMsgs: sessionCount ? Math.round((sessionLenSum / sessionCount) * 10) / 10 : 0,
      gapHours: SESSION_GAP_HOURS,
      starts: sessionStarts,
      ends: sessionEnds,
    },
    rhythm: {
      heatmap,
      hourly,
      nightShare: eff.length ? Math.round((nightCount / eff.length) * 1000) / 1000 : 0,
      peakHour: peakHour < 0 ? 0 : peakHour,
      monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)),
      weekly: [...weekly.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-12).map(([week, total]) => ({ week, total })),
    },
    turnTaking: { avgConsecutive },
    funFacts,
    balance,
  };
}

function computeFunFacts(
  eff: EffectiveMessage[],
  per: Map<string, PersonStat>,
  emojiCounts: Map<string, Map<string, number>>,
  heatmap: number[][],
  dayCounts: Map<string, number>,
  maxGap: number,
  silenceIdx: number,
): FunFacts {
  let goldenHour: FunFacts["goldenHour"] = null;
  for (let w = 0; w < 7; w++)
    for (let h = 0; h < 24; h++)
      if (heatmap[w][h] > (goldenHour?.count ?? 0)) goldenHour = { weekday: w, hour: h, count: heatmap[w][h] };
  let busiestDay: FunFacts["busiestDay"] = null;
  for (const [date, c] of dayCounts) if (c > (busiestDay?.count ?? 0)) busiestDay = { date, count: c };
  const longestSilence =
    silenceIdx > 0 && maxGap >= GAP_MS
      ? {
          hours: Math.round((maxGap / 3600_000) * 10) / 10,
          brokenById: eff[silenceIdx].pid,
          brokenAt: eff[silenceIdx].at,
          messageIndex: eff[silenceIdx].index,
          precededByIndex: eff[silenceIdx - 1].index,
        }
      : null;
  const topEmoji: Record<string, string | null> = {};
  for (const [pid, counts] of emojiCounts) {
    let best: string | null = null;
    let bestCount = 0;
    for (const [ch, c] of counts) if (c > bestCount) [best, bestCount] = [ch, c];
    topEmoji[pid] = best;
  }
  const people = [...per.values()];
  const pick = <T>(arr: T[], score: (x: T) => number): T | null => {
    let best: T | null = null;
    let bestScore = 0;
    for (const x of arr) {
      const s = score(x);
      if (s > bestScore) [best, bestScore] = [x, s];
    }
    return best;
  };
  const nightOwlP = pick(people, (p) => p.lateNight);
  const laughsP = pick(people.filter((p) => p.textMessages >= 10), (p) => p.laughs / Math.max(1, p.textMessages));
  const ghostP = people.length >= 3 ? pick(people, (p) => p.longestSilentDays) : null;
  const photosP = pick(people, (p) => p.photos);
  const linksP = pick(people, (p) => p.links);
  const firstDate = eff[0]?.at.slice(0, 10) ?? null;
  const lastDate = eff[eff.length - 1]?.at.slice(0, 10) ?? null;
  const firstDay = firstDate ? { date: firstDate, indices: eff.filter((m) => m.at.startsWith(firstDate) && m.kind === "TEXT").slice(0, 8).map((m) => m.index) } : null;
  const lastDayMsgs = lastDate ? eff.filter((m) => m.at.startsWith(lastDate) && m.kind === "TEXT") : [];
  const lastDay = lastDate ? { date: lastDate, indices: lastDayMsgs.slice(-8).map((m) => m.index) } : null;
  const longestMessages = people
    .filter((p) => p.longestMessageIndex !== null && p.longestMessageLen >= 40)
    .sort((a, b) => b.longestMessageLen - a.longestMessageLen)
    .slice(0, 3)
    .map((p) => ({ id: p.id, index: p.longestMessageIndex!, len: p.longestMessageLen, date: eff.find((m) => m.index === p.longestMessageIndex)?.at.slice(0, 10) ?? "" }));
  // 최장 연속 대화일수
  const days = [...dayCounts.keys()].sort();
  let longestStreak = 0;
  let streak = 0;
  let prevDay: number | null = null;
  for (const d of days) {
    const ms = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
    streak = prevDay !== null && ms - prevDay === 86_400_000 ? streak + 1 : 1;
    if (streak > longestStreak) longestStreak = streak;
    prevDay = ms;
  }
  return {
    goldenHour,
    busiestDay,
    longestSilence,
    firstMessageIndex: eff[0]?.index ?? null,
    topEmoji,
    nightOwl: nightOwlP ? { id: nightOwlP.id, count: nightOwlP.lateNight } : null,
    mostLaughs: laughsP ? { id: laughsP.id, perMessage: Math.round((laughsP.laughs / Math.max(1, laughsP.textMessages)) * 100) / 100 } : null,
    ghost: ghostP && ghostP.longestSilentDays >= 7 ? { id: ghostP.id, days: ghostP.longestSilentDays } : null,
    mostPhotos: photosP ? { id: photosP.id, count: photosP.photos } : null,
    linkCurator: linksP ? { id: linksP.id, count: linksP.links } : null,
    firstDay,
    lastDay,
    longestMessages,
    longestActiveStreakDays: longestStreak,
    laughRanking: [],
    longestLaughRun: null,
    topWords: [],
    verbalTics: [],
    topEmojis: [],
    emoticonShare: {},
  };
}

/** 2인 대화의 비대칭 지표. 기준 참여자는 업로더, 미지정이면 첫 참여자(ADR-16). 숫자 사실·Tier 0는 이름으로 표기하므로 어느 쪽이 기준이든 결과는 대칭이다. */
function computeBalance(perPerson: PersonStat[], uploaderId: string | null): ChatStats["balance"] {
  if (perPerson.length !== 2) return null;
  const ref = uploaderId && perPerson.some((p) => p.id === uploaderId) ? uploaderId : perPerson[0].id;
  const me = perPerson.find((p) => p.id === ref);
  const other = perPerson.find((p) => p.id !== ref);
  if (!me || !other) return null;
  const ratio = (a: number, b: number) => (a + b > 0 ? a / (a + b) : 0.5);
  const messageRatio = ratio(me.textMessages, other.textMessages); // 텍스트 기준 (첨부 제외)
  const initiationRatio = ratio(me.initiations, other.initiations);
  const questionRatio = ratio(me.questions, other.questions);
  const replySpeedRatio =
    me.replyMedianSec !== null && other.replyMedianSec !== null && me.replyMedianSec + other.replyMedianSec > 0
      ? me.replyMedianSec / (me.replyMedianSec + other.replyMedianSec)
      : null;
  // 양수 = 업로더가 더 기울어짐: 메시지·선톡·질문을 많이 하고 답장은 빠름
  const parts = [messageRatio - 0.5, initiationRatio - 0.5, questionRatio - 0.5];
  if (replySpeedRatio !== null) parts.push(0.5 - replySpeedRatio);
  const lean = Math.max(-1, Math.min(1, (parts.reduce((a, b) => a + b, 0) / parts.length) * 2));
  return {
    uploaderId: me.id,
    otherId: other.id,
    messageRatio: round3(messageRatio),
    initiationRatio: round3(initiationRatio),
    replySpeedRatio: replySpeedRatio === null ? null : round3(replySpeedRatio),
    questionRatio: round3(questionRatio),
    lean: round3(lean),
  };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
