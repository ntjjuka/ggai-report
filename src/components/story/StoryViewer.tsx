"use client";
// 통계 스토리 7장 (docs/17 실측 2) — Tier 0, LLM 없음
import { useState } from "react";
import Link from "next/link";
import type { StoryCard } from "@/lib/tier0/story";
import { Avatar, Bar, BigNumber, ChatBubble, PastelCard, WizardHeader, colorFor } from "@/components/ui";

const HOUR_LABELS: Record<number, string> = { 0: "밤 12시", 6: "오전 6시", 12: "낮 12시", 18: "저녁 6시" };

function hourLabel(h: number): string {
  if (h === 0) return "밤 12시";
  if (h < 12) return `오전 ${h}시`;
  if (h === 12) return "낮 12시";
  return `오후 ${h - 12}시`;
}

export default function StoryViewer({ cards, then, backHref, persona }: { cards: StoryCard[]; then: string | null; backHref: string; persona: string }) {
  const [i, setI] = useState(0);
  const card = cards[i];
  const total = cards.length;
  const colorOfName = (name: string) => {
    const idx = cards.find((c) => c.key === "who_more_who_first");
    const list = idx && idx.key === "who_more_who_first" ? idx.share.map((s) => s.name) : [];
    const k = list.indexOf(name);
    return colorFor(k < 0 ? 7 : k);
  };
  return (
    <div>
      <WizardHeader step={i + 1} total={total} onBack={i > 0 ? () => setI(i - 1) : undefined} backHref={i === 0 ? backHref : undefined} />
      <h1 className="mb-6 text-2xl font-extrabold">{card.title}</h1>
      <div className="space-y-4">{render(card, colorOfName)}</div>
      <div className="mt-8">
        {i < total - 1 ? (
          <button type="button" className="btn-primary" onClick={() => setI(i + 1)}>
            다음 →
          </button>
        ) : then ? (
          <Link href={then} className="btn-primary">
            {persona} 보고서 보기 →
          </Link>
        ) : (
          <Link href={backHref} className="btn-primary">
            대화로 돌아가기 →
          </Link>
        )}
      </div>
    </div>
  );
}

function render(card: StoryCard, colorOfName: (n: string) => string) {
  switch (card.key) {
    case "overview":
      return (
        <>
          <div className="glow-card rounded-3xl p-8 text-center text-white">
            <div className="text-7xl font-black drop-shadow">{card.messageCount.toLocaleString()}</div>
            <div className="text-xl font-semibold">메시지</div>
            <div className="mt-3 inline-block rounded-full bg-white px-4 py-1.5 text-sm font-bold text-emerald-700">📶 {card.signalLabel}</div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <PastelCard tone="mint">
              <BigNumber value={card.days} unit="일" sub={`${card.from} ~ ${card.to}`} />
            </PastelCard>
            <PastelCard tone="lavender">
              <BigNumber value={card.activeDays} unit="일" sub="대화한 날" />
            </PastelCard>
            <PastelCard tone="pink">
              <BigNumber value={card.participants} unit="명" sub="참여자" />
            </PastelCard>
            <PastelCard tone="yellow">
              <BigNumber value={card.textMessages} unit="개" sub="텍스트 메시지" />
            </PastelCard>
          </div>
        </>
      );
    case "who_more_who_first":
      return (
        <>
          <PastelCard tone="lavender" title="대화 지분 (텍스트 기준)">
            <div className="flex items-center gap-6">
              <Donut slices={[...card.share.map((s, i) => ({ pct: s.pct, color: colorFor(i) })), { pct: card.restPct, color: "#c9c0f0" }]} />
              <ul className="flex-1 space-y-1 text-sm">
                {card.share.map((s, i) => (
                  <li key={s.id} className="flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-3 w-3 rounded-full" style={{ background: colorFor(i) }} />
                      <span className="w-6 text-xs opacity-60">#{i + 1}</span>
                      <b>{s.name}</b>
                    </span>
                    <b>{s.pct}%</b>
                  </li>
                ))}
                {card.restPct > 0 && (
                  <li className="flex items-center justify-between opacity-70">
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-3 w-3 rounded-full bg-[#c9c0f0]" />
                      <span className="w-6" />
                      나머지
                    </span>
                    <b>{card.restPct}%</b>
                  </li>
                )}
              </ul>
            </div>
          </PastelCard>
          <PastelCard tone="pink" title="먼저 말 건 사람">
            {card.initiation.map((s, i) => (
              <Bar key={s.id} pct={s.pct} color={colorFor(i)} label={s.name} right={`${s.pct}%`} />
            ))}
          </PastelCard>
          {card.vocatives.length > 0 && (
            <PastelCard tone="peach" title="서로를 부르는 말">
              <div className="grid gap-4 sm:grid-cols-3">
                {card.vocatives.map((v) => (
                  <div key={v.id}>
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <span className="inline-block h-3 w-3 rounded-full" style={{ background: colorOfName(v.name) }} />
                      {v.name}
                    </div>
                    <div className="text-4xl font-extrabold">{v.term}</div>
                    <div className="text-sm opacity-70">{v.count}번</div>
                  </div>
                ))}
              </div>
            </PastelCard>
          )}
        </>
      );
    case "rhythm":
      return (
        <>
          {card.fastReply.length > 0 && (
            <PastelCard tone="lavender" title="칼답률">
              <div className="grid grid-cols-3 items-end gap-3">
                {[card.fastReply[1], card.fastReply[0], card.fastReply[2]].map((p, pos) =>
                  p ? (
                    <div key={p.id} className={`rounded-2xl p-4 text-center ${pos === 1 ? "bg-white/60 py-6" : "bg-white/30"}`}>
                      <div className="text-2xl">{pos === 1 ? "🥇" : pos === 0 ? "🥈" : "🥉"}</div>
                      <div className="text-sm font-semibold">{p.name}</div>
                      <div className="text-2xl font-extrabold">{p.pct}%</div>
                    </div>
                  ) : (
                    <div key={pos} />
                  ),
                )}
              </div>
              <div className="mt-2 text-xs opacity-70">1분 안에 보낸 답장 비율</div>
            </PastelCard>
          )}
          {card.busiestDay && (
            <PastelCard tone="peach" title="메시지가 가장 많았던 날">
              <BigNumber value={card.busiestDay.count} unit={`개 · ${fmtDate(card.busiestDay.date)}`} />
            </PastelCard>
          )}
          <div className="grid grid-cols-2 gap-4">
            <PastelCard tone="mint" title="최장 연속 대화">
              <BigNumber value={card.longestStreakDays} unit="일" />
            </PastelCard>
            <PastelCard tone="pink" title="가장 길었던 침묵">
              <BigNumber value={card.longestSilenceDays} unit="일" />
            </PastelCard>
          </div>
          <PastelCard tone="yellow" title="시간대별">
            <Hourly hourly={card.hourly} />
            <div className="mt-2 text-sm opacity-80">
              밤 10시~새벽 5시 {card.nightSharePct}% · 가장 활발한 시간 {hourLabel(card.peakHour)}
            </div>
          </PastelCard>
        </>
      );
    case "longest_messages":
      return card.items.length ? (
        card.items.map((it) => (
          <PastelCard key={it.id} tone="beige">
            <div className="text-lg font-bold">{it.name}</div>
            <BigNumber value={it.len} unit="자" sub={fmtDate(it.date)} />
            <details className="mt-3">
              <summary className="cursor-pointer text-sm opacity-70">더 보기</summary>
              <div className="bubble mt-2 text-[14px]">{it.text}</div>
            </details>
            <div className="bubble mt-3 max-h-40 overflow-hidden text-[14px]">{it.text}</div>
          </PastelCard>
        ))
      ) : (
        <PastelCard tone="beige">긴 메시지가 없어요. 다들 짧게 말하는 방이네요.</PastelCard>
      );
    case "first_day":
    case "last_day":
      return (
        <PastelCard tone="beige">
          <div className="mb-3 text-lg font-bold">{fmtDate(card.date)}</div>
          {card.bubbles.length ? card.bubbles.map((b, i) => <ChatBubble key={`${b.at}-${i}`} name={b.name} text={b.text} showName={i === 0 || card.bubbles[i - 1].name !== b.name} color={colorOfName(b.name)} />) : <div className="text-sm opacity-70">텍스트 메시지가 없는 날이에요.</div>}
        </PastelCard>
      );
    case "frequent_words":
      return (
        <>
          {card.laughRanking.length > 0 && (
            <PastelCard tone="pink" title="웃음 지문">
              <ul className="space-y-1 text-sm">
                {card.laughRanking.map((r, i) => (
                  <li key={r.id} className="flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-3 w-3 rounded-full" style={{ background: colorOfName(r.name) }} />
                      <span className="w-6 text-xs opacity-60">#{i + 1}</span>
                      <b>{r.name}</b>
                    </span>
                    <b>ㅋ×{r.count.toLocaleString()}</b>
                  </li>
                ))}
              </ul>
              {card.longestLaughRun && (
                <div className="mt-2 text-sm opacity-70">
                  최고 기록 ㅋ {card.longestLaughRun.len}연타 · {card.longestLaughRun.name}
                </div>
              )}
            </PastelCard>
          )}
          {card.verbalTics.length > 0 && (
            <PastelCard tone="peach" title="말버릇">
              {card.verbalTics.map((t) => (
                <div key={t.word} className="text-xl font-bold">
                  {t.word} <span className="text-sm font-semibold opacity-60">×{t.count}</span>
                </div>
              ))}
              <div className="mt-2 text-sm opacity-70">평균적인 한국 채팅보다 몇 배 더 쓰는지.</div>
            </PastelCard>
          )}
          {card.topWords.length > 0 && (
            <PastelCard tone="mint" title="가장 많이 쓴 단어">
              <ol className="space-y-1">
                {card.topWords.map((w, i) => (
                  <li key={w.word} className="flex items-center gap-3 text-xl font-bold">
                    <span className="w-6 text-xs opacity-60">#{i + 1}</span>
                    {w.word}
                  </li>
                ))}
              </ol>
            </PastelCard>
          )}
          {card.topEmojis.length > 0 && (
            <PastelCard tone="yellow" title="가장 많이 쓴 이모지">
              <div className="text-4xl">{card.topEmojis.map((e) => e.emoji).join("  ")}</div>
            </PastelCard>
          )}
          <PastelCard tone="lavender" title="이모티콘">
            <BigNumber value={card.emoticonTotal} unit="개" />
            <div className="mt-3">
              {card.emoticonShare.map((s, i) => (
                <Bar key={s.id} pct={s.pct} color={colorFor(i)} label={s.name} right={`${s.pct}%`} />
              ))}
            </div>
          </PastelCard>
        </>
      );
  }
}

function fmtDate(d: string): string {
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  return `${y}년 ${m}월 ${day}일`;
}

function Donut({ slices }: { slices: { pct: number; color: string }[] }) {
  const r = 40;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width="140" height="140" viewBox="0 0 100 100" aria-label="대화 지분 도넛 차트">
      <circle cx="50" cy="50" r={r} fill="none" stroke="#ffffff66" strokeWidth="16" />
      {slices.map((s, i) => {
        const len = (s.pct / 100) * c;
        const el = <circle key={i} cx="50" cy="50" r={r} fill="none" stroke={s.color} strokeWidth="16" strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} transform="rotate(-90 50 50)" />;
        offset += len;
        return el;
      })}
    </svg>
  );
}

function Hourly({ hourly }: { hourly: number[] }) {
  const max = Math.max(1, ...hourly);
  return (
    <div>
      <div className="flex h-28 items-end gap-[3px]">
        {hourly.map((v, h) => (
          <div key={h} className="flex-1 rounded-t-sm" style={{ height: `${Math.max(3, (v / max) * 100)}%`, background: h >= 22 || h < 5 ? "#5a4a00" : "#c9b45a" }} title={`${hourLabel(h)} ${v}개`} />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs opacity-70">
        {Object.entries(HOUR_LABELS).map(([h, l]) => (
          <span key={h}>{l}</span>
        ))}
      </div>
    </div>
  );
}

export { Avatar };
