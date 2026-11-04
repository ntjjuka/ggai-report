// 공용 UI 조각 (서버/클라이언트 공용, 상태 없음)
import type { ReactNode } from "react";

export const PALETTE = ["#ff8ad8", "#ffd23f", "#7ee8c6", "#b9b0ff", "#ffb48a", "#ff9ccf", "#f6c84c", "#8fe1c9", "#c0b3ff", "#ffc2a3"];

export function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

export function WizardHeader({ step, total, onBack, backHref }: { step: number; total: number; onBack?: () => void; backHref?: string }) {
  const pct = Math.round((step / total) * 100);
  return (
    <div className="mb-8 flex items-center gap-4">
      {backHref ? (
        <a href={backHref} aria-label="뒤로" className="rounded-xl p-2 hover:bg-gray-100">
          ←
        </a>
      ) : (
        <button type="button" onClick={onBack} aria-label="뒤로" className="rounded-xl p-2 hover:bg-gray-100" disabled={!onBack}>
          ←
        </button>
      )}
      <div className="h-3 flex-1 overflow-hidden rounded-full bg-gray-200">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm text-muted">
        {step}/{total}
      </span>
    </div>
  );
}

export function PastelCard({ tone, title, children, className = "" }: { tone: "lavender" | "pink" | "peach" | "mint" | "yellow" | "beige"; title?: string; children: ReactNode; className?: string }) {
  const bg: Record<string, string> = {
    lavender: "bg-pastel-lavender text-[#3c2a7a]",
    pink: "bg-pastel-pink text-[#8a1f4f]",
    peach: "bg-pastel-peach text-[#7a3b12]",
    mint: "bg-pastel-mint text-[#115c43]",
    yellow: "bg-pastel-yellow text-[#6b4f00]",
    beige: "bg-pastel-beige text-[#4a3c2a]",
  };
  return (
    <section className={`card-pastel ${bg[tone]} ${className}`}>
      {title && <h3 className="mb-3 text-lg font-bold">{title}</h3>}
      {children}
    </section>
  );
}

export function BigNumber({ value, unit, sub }: { value: string | number; unit?: string; sub?: string }) {
  return (
    <div>
      <span className="text-5xl font-extrabold tracking-tight">{typeof value === "number" ? value.toLocaleString() : value}</span>
      {unit && <span className="ml-1 text-base font-semibold opacity-70">{unit}</span>}
      {sub && <div className="mt-1 text-sm opacity-70">{sub}</div>}
    </div>
  );
}

export function Bar({ pct, color, label, right }: { pct: number; color: string; label: string; right: string }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-24 shrink-0 truncate text-sm font-semibold">{label}</span>
      <div className="h-3 flex-1 overflow-hidden rounded-full bg-black/10">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(2, pct))}%`, background: color }} />
      </div>
      <span className="w-12 shrink-0 text-right text-sm font-bold">{right}</span>
    </div>
  );
}

export function Avatar({ name, color, size = 40 }: { name: string; color: string; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white" style={{ width: size, height: size, background: color, fontSize: size * 0.45 }}>
      {[...name][0] ?? "?"}
    </span>
  );
}

export function ChatBubble({ name, text, showName = true, color }: { name: string; text: string; showName?: boolean; color?: string }) {
  return (
    <div className="mb-2">
      <div className="bubble">
        {showName && (
          <div className="mb-0.5 text-xs font-bold" style={{ color: color ?? "#8a5a1f" }}>
            {name}
          </div>
        )}
        <div className="text-[15px] leading-snug">{text}</div>
      </div>
    </div>
  );
}

export function ConfidenceChip({ level }: { level: "HIGH" | "MEDIUM" | "LOW" }) {
  const map = { HIGH: ["확실해", "bg-emerald-100 text-emerald-800"], MEDIUM: ["아마도", "bg-amber-100 text-amber-800"], LOW: ["감이야", "bg-gray-100 text-gray-700"] } as const;
  const [label, cls] = map[level];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{label}</span>;
}

export function Evidence({ items, colorOf }: { items: { messageId: string; participantName: string; at: string; text: string }[]; colorOf?: (name: string) => string }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3 rounded-2xl bg-pastel-beige/60 p-3">
      {items.map((e) => (
        <div key={e.messageId} className="mb-2 last:mb-0">
          <div className="text-xs text-muted">
            <span className="font-bold" style={{ color: colorOf?.(e.participantName) ?? "#8a5a1f" }}>
              {e.participantName}
            </span>{" "}
            · {e.at.replace("T", " ")} · {e.messageId}
          </div>
          <div className="bubble mt-1 text-[14px]">{e.text}</div>
        </div>
      ))}
    </div>
  );
}
