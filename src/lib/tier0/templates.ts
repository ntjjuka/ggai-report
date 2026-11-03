// Tier 0 템플릿 — 까비서 톤(14 문서) 한 줄들. 숫자는 서버 값만 삽입. LLM 없음.
// 결정적 선택: seed(대화 ID 해시)로 같은 입력엔 같은 문장.

export interface TemplateContext {
  me: string | null; // 업로더 이름
  other: string | null; // 1:1 상대
  n: number; // 참여자 수
}

export interface Line {
  topic: string;
  text: string;
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pick<T>(arr: T[], seed: number, salt: number): T {
  return arr[(seed + salt * 7919) % arr.length];
}

export const SIGNATURES = [
  "보고 끝. 결재는 네가 해.",
  "스크린샷은 자유, 반박은 카톡으로.",
  "내 말이 틀렸으면 둘이 잘 지내고 있다는 뜻이니까, 그것도 좋은 소식.",
  "다음 떡볶이는 네가 사.",
];

export const HEADLINES = {
  oneWay: ["둘 중 한 명만 연애 중이다", "한 명이 달리고 한 명이 걷는다", "선톡은 {me}, 결정은 {other}"],
  balanced: ["이 정도면 둘 다 진심이다", "티키타카, 숫자로도 증명됨", "둘이 같은 속도로 걷는다"],
  cold: ["이 대화는 미지근한 온탕이다", "둘 다 바쁘다. 서로에게만", "메시지는 있고 대화는 없다"],
  groupGhost: ["{n}명 방인데 말하는 건 세 명이다", "이 방의 반은 유령이다", "단톡방인데 독백이 많다"],
  groupLively: ["이 방은 꺼지지 않는다", "{n}명이 돌아가며 불을 지킨다", "회의록 없는 주간회의, 그래도 재밌다"],
  groupQuiet: ["이 방은 공지방이 되어가고 있다", "말하는 사람 하나, 읽는 사람 {n}명", "조용한 방, 그래도 아무도 안 나갔다"],
};

export const LINES = {
  initiation: [
    "선톡 {a}%대 {b}%. 이건 대화가 아니라 방송이야.",
    "먼저 말 거는 건 {me}가 {a}%. 상대는 받는 걸 좋아해.",
    "{me}가 {a}% 먼저 켰어. 이 대화의 전원 버튼은 네 손에 있어.",
  ],
  initiationBalanced: ["선톡 {a}%대 {b}%. 누가 먼저 켜도 이상하지 않은 사이.", "먼저 말 거는 비율이 비슷해. 드문 일이야."],
  replySlow: [
    "{name} 답장 중앙값 {dur}. 이건 카톡이 아니라 등기우편이야.",
    "{name}는 {dur} 뒤에 답해. 읽긴 읽었어. 아마도.",
    "{dur}. {name}의 답장은 메시지가 아니라 편지야.",
  ],
  replyFast: ["{name} 답장 중앙값 {dur}. 알림을 기다리고 있었다는 뜻이야.", "{name}는 {dur} 안에 답해. 손이 빠른 게 아니라 마음이 빨라."],
  replyGap: ["답장 속도 차이: {fast}는 {fdur}, {slow}는 {sdur}. 같은 대화를 다른 시간대에 하고 있어."],
  night: ["새벽 0~5시 메시지 {count}개, 그중 {share}%가 {name}. 밤에 더 솔직해지는 사람이야.", "{name}의 새벽 메시지 {count}개. 낮엔 다른 사람인 거지."],
  laugh: ["ㅋ 밀도 1위 {name}, 메시지당 {per}개. 웃기거나, 웃어주거나.", "{name}는 메시지당 ㅋ {per}개. 이 대화의 배경음악이야."],
  photo: ["사진 {count}장 중 대부분이 {name}. 말보다 사진이 편한 사람이야.", "{name}는 사진 {count}장을 보냈어. 답은 평균 몇 개였을까."],
  silence: [
    "최장 침묵 {dur}. 깬 사람은 {name}. 침묵을 깨는 쪽이 늘 같은지 봐.",
    "{dur} 동안 아무도 말이 없었어. 그걸 {name}가 깼지. 기억해 둬.",
  ],
  volume: ["메시지 {total}개, {days}일. 하루 {perDay}개꼴이야.", "{days}일 동안 {total}개. 대화한 날은 {active}일. 나머지 날은 각자 살았어."],
  golden: ["가장 많이 떠든 시간은 {wd}요일 {hour}시. 이 시간엔 둘 다 핸드폰을 보고 있어.", "{wd}요일 {hour}시가 골든아워. 중요한 얘기는 이때 해."],
  share: ["메시지 비율 {a}%대 {b}%. 말을 많이 하는 쪽이 꼭 마음이 큰 건 아니지만, 보통은 그래.", "{a}%대 {b}%. 한 명이 쓰고 한 명이 읽는 구조에 가까워."],
  groupBalance: ["상위 1명이 전체의 {topShare}%를 말했어. 이 방의 방송국이야.", "{n}명 중 {active}명이 90%를 말해. 나머지는 시청자."],
  groupGhost: ["{name}는 {days}일 동안 한 마디도 안 했어. 돌아오긴 했어. 그게 중요해.", "최장 잠수 {days}일, {name}. 유령도 가끔 출근해."],
  closer: ["대화 마무리는 {share}%가 {name}. 마지막 말을 하는 사람이 아니라, 답을 못 받는 사람일 수도 있어."],
  question: ["질문 비율 {a}%대 {b}%. 궁금해하는 쪽이 더 달리는 쪽이야."],
};

export function fill(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    return v === null || v === undefined ? "" : String(v);
  });
}
