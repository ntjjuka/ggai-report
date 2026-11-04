// 대화 시각(`yyyy-MM-ddTHH:mm`, TZ 없음)을 UTC 기준 분으로 다뤄 DST/타임존 영향을 제거한다.

export function atToMs(at: string): number {
  return Date.UTC(
    Number(at.slice(0, 4)),
    Number(at.slice(5, 7)) - 1,
    Number(at.slice(8, 10)),
    Number(at.slice(11, 13)),
    Number(at.slice(14, 16)),
  );
}

export function msToAt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function dateKey(at: string): string {
  return at.slice(0, 10);
}

export function monthKey(at: string): string {
  return at.slice(0, 7);
}

export function hourOf(at: string): number {
  return Number(at.slice(11, 13));
}

/** 0=일요일 … 6=토요일 */
export function weekdayOf(at: string): number {
  return new Date(atToMs(at)).getUTCDay();
}

/** ISO 주 시작(월요일) 날짜 키 */
export function weekKey(at: string): string {
  const ms = atToMs(at);
  const d = new Date(ms);
  const day = d.getUTCDay(); // 0=일
  const diff = (day + 6) % 7; // 월요일까지의 일수
  const monday = new Date(ms - diff * 86_400_000);
  return msToAt(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate())).slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((atToMs(b) - atToMs(a)) / 86_400_000);
}

/** 한국어 주차 라벨: "2025년 6월 둘째 주" */
export function weekLabelKo(dateKeyStr: string): string {
  const y = Number(dateKeyStr.slice(0, 4));
  const m = Number(dateKeyStr.slice(5, 7));
  const d = Number(dateKeyStr.slice(8, 10));
  const nth = Math.floor((d - 1) / 7); // 0..4
  const names = ["첫째", "둘째", "셋째", "넷째", "다섯째"];
  return `${y}년 ${m}월 ${names[Math.min(nth, 4)]} 주`;
}

export function formatDuration(sec: number): string {
  if (sec < 60) return "1분 미만";
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return `${minutes}분`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m ? `${h}시간 ${m}분` : `${h}시간`;
  const days = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${days}일 ${rh}시간` : `${days}일`;
}
