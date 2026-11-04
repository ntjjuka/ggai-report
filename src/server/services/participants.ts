// 참여자 매핑(병합·제외·업로더)과 이름 변경 병합 제안 (docs/03 §5)
import type { Message } from "@/lib/parser/types";
import { atToMs } from "@/lib/stats/time";
import type { EffectiveParticipant, ParticipantMap } from "@/lib/stats/types";
import type { ParticipantRow, ParticipantSnapshotEntry } from "../schema";

/** DB 참여자 행 → 유효 참여자 맵 (rawName → 대표 참여자). 제외·봇 제거, 병합은 대표(merged_into)로. */
export function buildParticipantMap(rows: ParticipantRow[], uploaderId: string | null): ParticipantMap {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const resolve = (r: ParticipantRow): ParticipantRow => {
    let cur = r;
    let hops = 0;
    while (cur.mergedIntoId && byId.has(cur.mergedIntoId) && hops < 5) {
      cur = byId.get(cur.mergedIntoId)!;
      hops += 1;
    }
    return cur;
  };
  const effective = new Map<string, EffectiveParticipant>();
  for (const r of rows) {
    if (r.isBot) continue;
    const rep = resolve(r);
    if (rep.excluded || r.excluded) continue;
    const e = effective.get(rep.id) ?? { id: rep.id, name: rep.displayName, rawNames: [], isUploader: rep.id === uploaderId };
    e.rawNames.push(r.rawName);
    effective.set(rep.id, e);
  }
  const map: ParticipantMap = new Map();
  for (const e of effective.values()) for (const raw of e.rawNames) map.set(raw, e);
  return map;
}

export function snapshotFromMap(map: ParticipantMap): ParticipantSnapshotEntry[] {
  const seen = new Map<string, ParticipantSnapshotEntry>();
  for (const e of map.values()) if (!seen.has(e.id)) seen.set(e.id, { id: e.id, name: e.name, rawNames: [...e.rawNames], isUploader: e.isUploader });
  return [...seen.values()];
}

export function mapFromSnapshot(snapshot: ParticipantSnapshotEntry[]): ParticipantMap {
  const map: ParticipantMap = new Map();
  for (const s of snapshot) for (const raw of s.rawNames) map.set(raw, { id: s.id, name: s.name, rawNames: s.rawNames, isUploader: s.isUploader });
  return map;
}

export interface MergeSuggestion {
  from: string; // participant id (옛 이름)
  into: string; // participant id (대표)
  confidence: number;
}

/**
 * 1:1 대화에서 이름이 3개 이상 감지되면(이름 변경) 화자 교대 가중치로 2분할해 병합을 제안한다 (toksai 알고리즘).
 * 단체방(9명 이상)은 제안하지 않는다. 결과는 제안일 뿐, 사용자가 확인한다.
 */
export function suggestMerges(messages: Message[], rows: ParticipantRow[]): MergeSuggestion[] {
  const names = rows.filter((r) => !r.isBot).map((r) => r.rawName);
  if (names.length < 3 || names.length > 8) return [];
  const idx = new Map(names.map((n, i) => [n, i]));
  const n = names.length;
  const w: number[][] = Array.from({ length: n }, () => Array<number>(n).fill(0));
  const GAP = 6 * 3600_000;
  let prev: Message | null = null;
  for (const m of messages) {
    if (m.sender === null || !idx.has(m.sender)) continue;
    if (prev && prev.sender !== m.sender) {
      const gap = atToMs(m.at) - atToMs(prev.at);
      if (gap >= 0 && gap <= GAP) {
        const a = idx.get(prev.sender!)!;
        const b = idx.get(m.sender)!;
        w[a][b] += 1;
        w[b][a] += 1;
      }
    }
    prev = m;
  }
  // 탐욕적 2분할: 교대가 많은 쪽을 반대 그룹에
  const group = new Map<number, 0 | 1>([[0, 0]]);
  const sizes = [1, 0];
  for (let i = 1; i < n; i++) {
    let cross0 = 0;
    let cross1 = 0;
    for (let j = 0; j < i; j++) {
      if (group.get(j) === 1) cross0 += w[i][j];
      else cross1 += w[i][j];
    }
    const g: 0 | 1 = cross1 > cross0 ? 1 : cross0 > cross1 ? 0 : sizes[0] <= sizes[1] ? 0 : 1;
    group.set(i, g);
    sizes[g] += 1;
  }
  const rowByName = new Map(rows.map((r) => [r.rawName, r]));
  const out: MergeSuggestion[] = [];
  for (const g of [0, 1] as const) {
    const members = names.filter((_, i) => group.get(i) === g).map((nm) => rowByName.get(nm)!);
    if (members.length < 2) continue;
    const rep = [...members].sort((a, b) => b.lastAt.localeCompare(a.lastAt) || b.messageCount - a.messageCount)[0];
    for (const m of members) {
      if (m.id === rep.id) continue;
      // 활동 기간이 겹치지 않으면 확신 ↑
      const overlap = !(m.lastAt < rep.firstAt || rep.lastAt < m.firstAt);
      const sameGroupWeight = w[idx.get(m.rawName)!][idx.get(rep.rawName)!];
      const confidence = Math.max(0.3, Math.min(0.95, (overlap ? 0.45 : 0.85) - Math.min(0.3, sameGroupWeight / 50)));
      out.push({ from: m.id, into: rep.id, confidence: Math.round(confidence * 100) / 100 });
    }
  }
  return out;
}
