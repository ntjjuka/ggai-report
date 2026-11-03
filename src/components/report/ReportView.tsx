// 까비서 보고서 렌더 (docs/07 §2 순서). 서버 컴포넌트.
import type { ReactNode } from "react";
import type { Evidence as EvidenceItem, ReportContent } from "@/lib/report/schema";
import { MOOD_LABEL } from "@/lib/report/schema";
import { formatDuration } from "@/lib/stats/time";
import { ConfidenceChip, Evidence, PastelCard, colorFor } from "@/components/ui";

const MOMENT_ICON: Record<string, string> = { funny: "😂", flutter: "💓", touching: "🥹", banter: "🏓", awkward: "😶", clash: "⚡" };
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export default function ReportView({ content, seq, actions, isOwner }: { content: ReportContent; seq: number; actions?: ReactNode; isOwner: boolean }) {
  const persona = content.persona.name;
  const colorIndex = new Map(content.meta.participants.map((p, i) => [p.name, i]));
  const colorOf = (name: string) => colorFor(colorIndex.get(name) ?? 7);
  const nameOf = (id: string) => content.meta.participants.find((p) => p.id === id)?.name ?? id;
  const isGroup = content.meta.participants.length > 2;
  const refs = content.inlineEvidence;
  const T = ({ s }: { s: string }) => <Prose text={s} refs={refs} colorOf={colorOf} />;
  // 멤버가 많으면 페르소나 본문은 접어 두고 「자세히 보기」로 펼친다 (칭호·유형·주제·한 줄 결론은 항상 보임)
  const collapsePersona = content.meta.participants.length > 4;

  return (
    <article className="space-y-8">
      {/* 0 헤더 */}
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="rounded-full bg-ink px-2 py-0.5 font-bold text-white">
            {persona} 보고서 No.{seq}
          </span>
          <span>{content.meta.title}</span>
          <span>·</span>
          <span>
            {content.meta.period.from} ~ {content.meta.period.to} · {content.meta.period.days}일 · 메시지 {content.meta.messageCount.toLocaleString()}개
          </span>
        </div>
        {content.verdict.reportTitle && <h1 className="text-3xl font-black leading-tight sm:text-4xl">{content.verdict.reportTitle}</h1>}
        <div className="flex flex-wrap gap-2">
          {content.meta.participants.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1 rounded-full border border-line px-3 py-1 text-sm font-semibold">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: colorOf(p.name) }} />
              {p.name}
              {p.isUploader && <span className="text-xs text-muted">(나)</span>}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-pastel-mint px-2 py-0.5 font-semibold text-[#115c43]">
            {persona}가 {content.meta.coveragePct}% 읽었어요
          </span>
          <span className="rounded-full bg-pastel-yellow px-2 py-0.5 font-semibold text-[#6b4f00]">오늘 {persona} 기분: {MOOD_LABEL[content.mood]}</span>
          {content.safety.notice && <span className="rounded-full bg-pastel-pink px-2 py-0.5 font-semibold text-[#8a1f4f]">농담 밀도 낮춤</span>}
        </div>
        {actions}
      </header>

      {content.safety.notice && <div className="rounded-2xl border border-pastel-pink bg-pastel-pink/50 px-4 py-3 text-sm text-[#8a1f4f]">{content.safety.notice}</div>}

      {/* 1 판정 */}
      <section className="card p-6">
        <div className="text-xs font-bold text-muted">{persona}의 첫마디</div>
        <h2 className="mt-2 text-3xl font-extrabold leading-tight">{content.verdict.headline}</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-ink px-3 py-1 text-xs font-bold text-white">
            {content.verdict.relationType.code} · {content.verdict.relationType.label}
          </span>
          <ConfidenceChip level={content.verdict.confidence} />
        </div>
        {content.verdict.body.map((p, i) => (
          <p key={i} className="mt-4 leading-relaxed">
            <T s={p} />
          </p>
        ))}
        {content.verdict.relationType.description && (
          <p className="mt-4 text-sm text-muted">
            <T s={content.verdict.relationType.description} />
          </p>
        )}
      </section>

      {/* 1a 장(章) — 이 방을 관통하는 코미디. 페르소나의 재료 */}
      {content.moments.length > 0 && (
        <Section title={`${persona}가 읽은 이 방의 코미디`} sub="끝까지 읽고 묶은 장(章)이야. 이 장면들이 아래 페르소나의 재료고, 말풍선은 실제 메시지.">
          <div className="space-y-4">
            {content.moments.map((m, i) => (
              <div key={i} className="rounded-3xl bg-pastel-beige p-5">
                <h4 className="text-lg font-extrabold leading-snug">
                  {MOMENT_ICON[m.kind] ?? "💬"} {m.title || m.caption}
                </h4>
                {m.summary &&
                  m.summary
                    .split(/\n\s*\n/)
                    .filter((par) => par.trim())
                    .map((par, j) => (
                      <p key={j} className="mt-3 leading-relaxed">
                        <T s={par.trim()} />
                      </p>
                    ))}
                {m.participants?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {m.participants.map((p) => (
                      <span key={p.id} className="rounded-full bg-white/70 px-2 py-0.5 text-xs font-semibold" style={{ color: colorOf(p.name) }}>
                        {p.name}
                      </span>
                    ))}
                  </div>
                )}
                {m.messages.map((e) => (
                  <div key={e.messageId} className="bubble mt-2 text-[14px]">
                    <div className="text-xs font-bold" style={{ color: colorOf(e.participantName) }}>
                      {e.participantName}
                    </div>
                    {e.text}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 1b 인물 페르소나 — 메인 코너 */}
      <Section title={isGroup ? "멤버 페르소나 · 전원 해부" : "두 사람 페르소나"} sub={`${persona}가 대화 속 팩트로만 깎았어. 말풍선은 그 사람이 실제로 보낸 메시지야.`}>
        {content.participants.length > 2 && (
          <ol className="mb-5 divide-y divide-line rounded-3xl border border-line bg-white">
            {content.participants.map((p) => (
              <li key={p.participantId}>
                <a href={`#persona-${p.participantId}`} className="flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-pastel-beige/50">
                  <span>{p.emoji}</span>
                  <span className="font-extrabold" style={{ color: colorOf(p.name) }}>
                    {p.name}
                  </span>
                  <span className="text-muted">—</span>
                  <span className="font-semibold">{p.epithet || p.nickname}</span>
                </a>
              </li>
            ))}
          </ol>
        )}
        <div className="space-y-5">
          {content.participants.map((p) => {
            const paragraphs = personaParagraphs(p);
            return (
              <article key={p.participantId} id={`persona-${p.participantId}`} className="scroll-mt-20 rounded-3xl border border-line bg-white p-5 sm:p-6" style={{ borderTopColor: colorOf(p.name), borderTopWidth: 5 }}>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-ink px-2 py-0.5 font-bold text-white">{p.type?.label || "미분류"}</span>
                  <span className="text-muted">
                    {p.name}
                    {p.isUploader ? " (나)" : ""}
                  </span>
                </div>
                <h4 className="mt-2 text-xl font-extrabold leading-snug sm:text-2xl">
                  <span className="mr-1">{p.emoji}</span>
                  <span style={{ color: colorOf(p.name) }}>{p.name}</span>
                  <span className="text-muted">: </span>
                  {p.title}
                </h4>
                {p.type?.description && (
                  <p className="mt-1 text-sm text-muted">
                    <T s={p.type.description} />
                  </p>
                )}
                {p.topics?.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-bold text-muted">관심사</span>
                    {p.topics.map((t) => (
                      <span key={t} className="rounded-full bg-pastel-lavender px-2 py-0.5 font-semibold text-[#3c2a7a]">
                        #{t}
                      </span>
                    ))}
                  </div>
                )}
                {p.oneLiner && <p className="mt-3 rounded-2xl bg-ink px-4 py-2 text-sm font-extrabold text-white">{p.oneLiner}</p>}
                <details className="disclosure mt-3" open={!collapsePersona}>
                  <summary className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-line px-3 py-1 text-xs font-bold text-muted select-none">
                    <span className="when-closed">자세히 보기 · 문단 {paragraphs.length}개 · 말풍선 {paragraphs.reduce((a, par) => a + par.quotes.length, 0)}개 ▾</span>
                    <span className="when-open">접기 ▴</span>
                  </summary>
                  <div className="mt-3 space-y-4">
                    {paragraphs.map((par, i) => (
                      <div key={i}>
                        <p className="leading-relaxed">
                          <T s={par.text} />
                        </p>
                        {par.quotes.length > 0 && (
                          <div className="mt-2 flex flex-col items-start gap-2 pl-3 sm:pl-6">
                            {par.quotes.map((e) => (
                              <div key={e.messageId} className="bubble text-[14px]" title={e.at.replace("T", " ")}>
                                <div className="text-xs font-bold" style={{ color: colorOf(e.participantName) }}>
                                  {e.participantName} · {e.at.slice(0, 10)}
                                </div>
                                {e.text}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
                {(p.badges.length > 0 || p.awardNames.length > 0) && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {p.badges.map((b) => (
                      <span key={b.id} className="rounded-full bg-pastel-yellow px-2 py-0.5 text-xs font-semibold text-[#6b4f00]">
                        {b.icon} {b.name}
                      </span>
                    ))}
                    {p.awardNames.map((a) => (
                      <span key={a} className="rounded-full bg-pastel-peach px-2 py-0.5 text-xs font-semibold text-[#7a3b12]">
                        🏆 {a}
                      </span>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </Section>

      {/* 1c 총평 및 미래 예측 */}
      {(content.verdict.predictions?.length ?? 0) > 0 && (
        <Section title="총평 및 미래 예측 · 너희의 다음 행보" sub="지금까지의 드라마를 그대로 이어 가면 이렇게 된다.">
          <ul className="space-y-2">
            {content.verdict.predictions.map((line, i) => (
              <li key={i} className="flex gap-2 rounded-2xl bg-pastel-lavender px-4 py-3 text-[#3c2a7a]">
                <span>🔮</span>
                <span className="leading-relaxed">
                  <T s={line} />
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 2 진짜 역학 */}
      <Section title="진짜 역학" sub={isGroup ? "판을 들고 있는 사람 / 사라지는 사람 / 판을 쥔 사람" : undefined}>
        {isGroup && (
          <div className="mb-4 grid gap-2 sm:grid-cols-3">
            {[
              ["판을 들고 있는 사람", content.dynamic.groupRoles.holdsTogether],
              ["사라지는 사람", content.dynamic.groupRoles.goesQuiet],
              ["판을 쥔 사람", content.dynamic.groupRoles.runsTheShow],
            ].map(([label, id]) => (
              <div key={label} className="rounded-2xl bg-pastel-lavender px-4 py-3 text-[#3c2a7a]">
                <div className="text-xs opacity-70">{label}</div>
                <div className="text-lg font-extrabold">{id ? nameOf(id) : "—"}</div>
              </div>
            ))}
          </div>
        )}
        {content.dynamic.paragraphs.map((p, i) => (
          <p key={i} className="mt-2 leading-relaxed">
            <T s={p} />
          </p>
        ))}
        <Evidence items={content.dynamic.evidence} colorOf={colorOf} />
      </Section>

      {/* 3 바뀐 주 */}
      <Section title="변동 보고 · 바뀐 주">
        {content.weekChanged.exists ? (
          <>
            <div className="text-2xl font-extrabold">{content.weekChanged.weekLabel}</div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl bg-pastel-mint p-4 text-[#115c43]">
                <div className="text-xs font-bold opacity-70">그 전</div>
                <p className="mt-1 text-sm leading-relaxed">
                  <T s={content.weekChanged.before} />
                </p>
              </div>
              <div className="rounded-2xl bg-pastel-pink p-4 text-[#8a1f4f]">
                <div className="text-xs font-bold opacity-70">그 뒤</div>
                <p className="mt-1 text-sm leading-relaxed">
                  <T s={content.weekChanged.after} />
                </p>
              </div>
            </div>
            {content.weekChanged.pivot && (
              <div className="mt-3">
                <div className="text-xs font-bold text-muted">그 주의 결정적 한 줄</div>
                <Evidence items={[content.weekChanged.pivot]} colorOf={colorOf} />
              </div>
            )}
            <div className="mt-2">
              <ConfidenceChip level={content.weekChanged.confidence} />
            </div>
          </>
        ) : (
          <p className="leading-relaxed">
            <T s={content.weekChanged.before || "바뀐 주가 없다. 이 대화는 처음 온도 그대로 흘러왔어."} />
          </p>
        )}
      </Section>

      {/* 2b 누가 먼저, 누가 아닌 척 */}
      {content.firstMove.body && (
        <Section title="누가 먼저 치고, 누가 아닌 척하는지">
          <div className="mb-3 flex flex-wrap gap-2">
            {content.firstMove.initiator && (
              <span className="rounded-full bg-pastel-pink px-3 py-1 text-sm font-bold text-[#8a1f4f]">먼저 치는 사람 · {content.firstMove.initiator.name}</span>
            )}
            {content.firstMove.pretender && (
              <span className="rounded-full bg-pastel-lavender px-3 py-1 text-sm font-bold text-[#3c2a7a]">아닌 척하는 사람 · {content.firstMove.pretender.name}</span>
            )}
          </div>
          <p className="leading-relaxed">
            <T s={content.firstMove.body} />
          </p>
          <Evidence items={content.firstMove.evidence} colorOf={colorOf} />
        </Section>
      )}

      {/* 2c 둘만의 언어와 반복되는 농담 */}
      {(content.privateLanguage.phrases.length > 0 || content.privateLanguage.runningJokes.length > 0) && (
        <Section title={isGroup ? "이 방만의 언어와 반복되는 농담" : "둘만의 언어와 반복되는 농담"}>
          <div className="grid gap-3 sm:grid-cols-2">
            {content.privateLanguage.phrases.map((p, i) => (
              <div key={`p${i}`} className="rounded-3xl bg-pastel-peach p-4 text-[#7a3b12]">
                <div className="text-2xl font-extrabold">「{p.phrase}」</div>
                <p className="mt-1 text-sm">
                  <T s={p.meaning} />
                </p>
                <Evidence items={p.evidence} colorOf={colorOf} />
              </div>
            ))}
            {content.privateLanguage.runningJokes.map((j, i) => (
              <div key={`j${i}`} className="rounded-3xl bg-pastel-yellow p-4 text-[#6b4f00]">
                <div className="text-xs font-bold opacity-70">반복되는 농담</div>
                <div className="text-lg font-extrabold">{j.title}</div>
                <p className="mt-1 text-sm">
                  <T s={j.summary} />
                </p>
                <Evidence items={j.evidence} colorOf={colorOf} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 5 발견 */}
      {content.findings.length > 0 && (
        <Section title="이 방만의 기현상" sub="다른 방에선 안 벌어지는 일">
          <div className="space-y-4">
            {content.findings.map((f) => (
              <div key={f.id} className="rounded-3xl bg-pastel-beige/60 p-5">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="font-extrabold">
                    {f.id}. {f.title}
                  </h4>
                  <ConfidenceChip level={f.confidence} />
                </div>
                <dl className="mt-2 space-y-1 text-sm">
                  <div>
                    <dt className="inline font-bold text-muted">보인 것 </dt>
                    <dd className="inline">
                      <T s={f.observed} />
                    </dd>
                  </div>
                  <div>
                    <dt className="inline font-bold text-muted">내 해석 </dt>
                    <dd className="inline">
                      <T s={f.interpretation} />
                    </dd>
                  </div>
                </dl>
                <Evidence items={f.evidence} colorOf={colorOf} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 6 내가 너라면 */}
      <Section title="비서 제안 3건 · 내가 너라면">
        <ol className="space-y-3">
          {content.whatIWouldDo.map((w, i) => (
            <li key={i} className="flex gap-3 rounded-2xl bg-pastel-mint p-4 text-[#115c43]">
              <span className="text-xl">☑</span>
              <div>
                <div className="font-extrabold">{w.title}</div>
                <p className="mt-1 text-sm leading-relaxed">
                  <T s={w.body} />
                </p>
                {w.deadline && <div className="mt-1 text-xs opacity-70">⏱ {w.deadline}</div>}
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {/* 7 어워드 */}
      {content.awards.length > 0 && (
        <Section title="이달의 상">
          <div className="grid gap-3 sm:grid-cols-2">
            {content.awards.map((a, i) => (
              <div key={i} className="rounded-3xl bg-pastel-yellow p-5 text-[#6b4f00]">
                <div className="text-2xl">🏆</div>
                <div className="mt-1 text-lg font-extrabold">{a.name}</div>
                <div className="font-semibold">{a.participantName ?? "한 줄"}</div>
                <p className="mt-1 text-sm">
                  <T s={a.reason} />
                </p>
                <Evidence items={a.evidence} colorOf={colorOf} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 8 점수 */}
      {content.scores.length > 0 && (
        <Section title="점수" collapsible>
          <div className="grid gap-3 sm:grid-cols-2">
            {content.scores.map((s) => (
              <div key={s.key} className="rounded-3xl border border-line p-4">
                <div className="flex items-center justify-between">
                  <span className="font-bold">{s.label}</span>
                  <ConfidenceChip level={s.confidence} />
                </div>
                <div className="mt-1 text-3xl font-extrabold">
                  {(s.value / 20).toFixed(1)}
                  <span className="text-base font-semibold text-muted">/5</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100">
                  <div className="h-full rounded-full bg-ink" style={{ width: `${s.value}%` }} />
                </div>
                <p className="mt-2 text-sm text-muted">{s.oneLiner}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 10 숫자로 보는 우리 */}
      <Section title="숫자로 보는 우리" collapsible>
        <div className="space-y-4">
          <PastelCard tone="lavender" title="월별 메시지">
            <Monthly monthly={content.visuals.monthly} participants={content.meta.participants} colorOf={colorOf} />
            <p className="mt-2 text-sm opacity-80">{content.visuals.captions.monthly}</p>
          </PastelCard>
          <PastelCard tone="yellow" title="요일 × 시간">
            <Heatmap heatmap={content.visuals.heatmap} />
            <p className="mt-2 text-sm opacity-80">{content.visuals.captions.heatmap}</p>
          </PastelCard>
          <div className="grid gap-4 sm:grid-cols-2">
            <PastelCard tone="pink" title="답장 속도">
              {content.meta.participants.map((p) => {
                const r = content.visuals.replyLatency[p.id];
                return (
                  <div key={p.id} className="flex items-center justify-between py-1 text-sm">
                    <span className="font-semibold">{p.name}</span>
                    <span>{r?.medianSec == null ? "집계 불가" : `중앙값 ${formatDuration(r.medianSec)}`}</span>
                  </div>
                );
              })}
              <p className="mt-2 text-sm opacity-80">{content.visuals.captions.reply}</p>
            </PastelCard>
            <PastelCard tone="mint" title="선톡 비율">
              {content.meta.participants.map((p) => (
                <div key={p.id} className="flex items-center justify-between py-1 text-sm">
                  <span className="font-semibold">{p.name}</span>
                  <span>{Math.round((content.visuals.initiationShare[p.id] ?? 0) * 100)}%</span>
                </div>
              ))}
              <p className="mt-2 text-sm opacity-80">{content.visuals.captions.initiation}</p>
            </PastelCard>
          </div>
        </div>
      </Section>

      {/* 11 답 */}
      {content.answer && (
        <Section title={`${persona}의 답`}>
          <div className="rounded-2xl bg-gray-100 px-4 py-2 text-sm text-muted">Q. {content.answer.question}</div>
          <p className="mt-3 leading-relaxed">
            <T s={content.answer.body} />
          </p>
          <div className="mt-2">
            <ConfidenceChip level={content.answer.confidence} />
          </div>
          <Evidence items={content.answer.evidence} colorOf={colorOf} />
        </Section>
      )}

      {/* 12 공유 카드 */}
      <section className="glow-card rounded-3xl p-8 text-white">
        <div className="text-sm font-semibold opacity-90">
          {persona}의 판정 {content.shareCard.emoji}
        </div>
        <div className="mt-2 text-3xl font-black leading-tight drop-shadow">{content.shareCard.headline}</div>
        {content.shareCard.subline && <div className="mt-3 text-base font-semibold opacity-95">{content.shareCard.subline}</div>}
        <div className="mt-6 text-sm opacity-90">{content.signature}</div>
      </section>

      <footer className="text-xs text-muted">
        <p>{content.disclaimer}</p>
        {isOwner && (
          <p className="mt-1">
            품질: {content.quality.mode === "SINGLE" ? "전체 읽음" : `청크 ${content.quality.chunks.succeeded}/${content.quality.chunks.total}`} · 근거 {content.quality.evidence.total - content.quality.evidence.dropped}/{content.quality.evidence.total} 검증 · 모델 {content.quality.models.synthesis} · {content.quality.durationSec}초 · 비용 ${content.quality.costUsd.toFixed(2)} · 토큰 입력 {content.quality.tokens.input.toLocaleString()} / 출력 {content.quality.tokens.output.toLocaleString()}
          </p>
        )}
      </footer>
    </article>
  );
}

/** 2026-11-03 이전 보고서(statement/softLanding/evidence)도 새 카드로 그린다 */
function personaParagraphs(p: ReportContent["participants"][number]): { text: string; quotes: EvidenceItem[] }[] {
  if (Array.isArray(p.paragraphs) && p.paragraphs.length) return p.paragraphs;
  const legacy = p as unknown as { statement?: string; softLanding?: string; evidence?: EvidenceItem[] };
  const out: { text: string; quotes: EvidenceItem[] }[] = [];
  if (legacy.statement) out.push({ text: legacy.statement, quotes: legacy.evidence ?? [] });
  if (legacy.softLanding) out.push({ text: legacy.softLanding, quotes: [] });
  return out;
}

/** 산문 속 m123 참조를 「발신자 「인용」」 칩으로. 근거 표에 없는 토큰은 숨긴다 (검증기가 이미 제거했어야 함). */
function Prose({ text, refs, colorOf }: { text: string; refs: Record<string, EvidenceItem> | undefined; colorOf: (n: string) => string }) {
  const parts = text.split(/(\bm\d+\b|\*\*[^*\n]{1,60}\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (/^\*\*[^*\n]{1,60}\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>; // 핵심 조어 강조 (마크다운 ** 만 허용)
        if (!/^m\d+$/.test(part)) return <span key={i}>{part}</span>;
        const e = refs?.[part];
        if (!e) return null;
        const chars = [...e.text];
        const short = chars.length > 28 ? chars.slice(0, 28).join("") + "…" : e.text;
        return (
          <span key={i} title={`${e.participantName} · ${e.at.replace("T", " ")} · ${e.text}`} className="mx-0.5 inline-flex max-w-full items-baseline gap-1 rounded-lg bg-pastel-beige px-1.5 py-0.5 align-baseline text-[0.82em] font-semibold text-[#4a3c2a]">
            <span style={{ color: colorOf(e.participantName) }}>{e.participantName}</span>
            <span className="font-normal">「{short}」</span>
          </span>
        );
      })}
    </>
  );
}

function Section({ title, sub, children, collapsible = false }: { title: string; sub?: string; children: ReactNode; collapsible?: boolean }) {
  if (collapsible) {
    // 부가 섹션은 접어 두고 「자세히 보기」로 연다 (JS 없이 동작하는 details)
    return (
      <section>
        <details className="disclosure">
          <summary className="flex cursor-pointer items-center justify-between gap-2 select-none">
            <h3 className="text-xl font-extrabold">{title}</h3>
            <span className="rounded-full border border-line px-3 py-1 text-xs font-bold text-muted">
              <span className="when-closed">자세히 보기 ▾</span>
              <span className="when-open">접기 ▴</span>
            </span>
          </summary>
          {sub && <p className="mb-2 text-sm text-muted">{sub}</p>}
          <div className="mt-3">{children}</div>
        </details>
      </section>
    );
  }
  return (
    <section>
      <h3 className="text-xl font-extrabold">{title}</h3>
      {sub && <p className="mb-2 text-sm text-muted">{sub}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Monthly({ monthly, participants, colorOf }: { monthly: ReportContent["visuals"]["monthly"]; participants: ReportContent["meta"]["participants"]; colorOf: (n: string) => string }) {
  const max = Math.max(1, ...monthly.map((m) => m.total));
  const shown = monthly.slice(-24);
  return (
    <div>
      <div className="flex h-32 items-end gap-1">
        {shown.map((m) => (
          <div key={m.month} className="flex flex-1 flex-col-reverse" style={{ height: "100%" }} title={`${m.month} ${m.total}개`}>
            {participants.map((p) => (
              <div key={p.id} style={{ height: `${((m.perPerson[p.id] ?? 0) / max) * 100}%`, background: colorOf(p.name) }} />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs opacity-70">
        <span>{shown[0]?.month}</span>
        <span>{shown[shown.length - 1]?.month}</span>
      </div>
    </div>
  );
}

function Heatmap({ heatmap }: { heatmap: number[][] }) {
  const max = Math.max(1, ...heatmap.flat());
  return (
    <div className="grid gap-[2px]" style={{ gridTemplateColumns: "auto repeat(24, minmax(0, 1fr))" }}>
      {heatmap.map((row, w) => (
        <div key={w} className="contents">
          <span className="pr-1 text-xs opacity-70">{WEEKDAYS[w]}</span>
          {row.map((v, h) => (
            <span key={h} className="aspect-square rounded-[2px]" style={{ background: `rgba(90, 74, 0, ${0.08 + (v / max) * 0.92})` }} title={`${WEEKDAYS[w]} ${h}시 ${v}개`} />
          ))}
        </div>
      ))}
    </div>
  );
}
