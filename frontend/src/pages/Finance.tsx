import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Wallet, TrendingDown, TrendingUp, AlertTriangle, Plus, Trash2, Check } from 'lucide-react';

// ---------- Data model ----------
type Certainty = 'certo' | 'probabile' | 'incerto';
type FinItem = {
  id: string;
  label: string;
  type: 'in' | 'out';
  amount: number;          // sempre positivo
  date?: string;           // YYYY-MM-DD (una tantum)
  recurringDay?: number;   // 1-28 → ricorrente mensile
  certainty: Certainty;
};
type FinanceData = {
  balance: number;
  balanceDate: string;     // YYYY-MM-DD
  horizonEnd: string;      // YYYY-MM-DD
  target?: number;         // obiettivo saldo a fine orizzonte
  items: FinItem[];
};

const uid = () => Math.random().toString(36).slice(2, 9);

// Seed iniziale: scadenze da simulazione UPF 2026 + pipeline incassi (second brain 19/07/2026)
function seedData(): FinanceData {
  return {
    balance: 623,
    balanceDate: '2026-07-19',
    horizonEnd: '2026-12-31',
    target: 6000,
    items: [
      { id: uid(), label: 'F24 rata 1', type: 'out', amount: 650.06, date: '2026-07-20', certainty: 'certo' },
      { id: uid(), label: 'F24 arretrato + ravvedimento (stima)', type: 'out', amount: 450, date: '2026-07-31', certainty: 'certo' },
      { id: uid(), label: 'F24 rata 2', type: 'out', amount: 651.94, date: '2026-08-20', certainty: 'certo' },
      { id: uid(), label: 'F24 rata 3', type: 'out', amount: 654.09, date: '2026-09-16', certainty: 'certo' },
      { id: uid(), label: 'F24 rata 4', type: 'out', amount: 656.24, date: '2026-10-16', certainty: 'certo' },
      { id: uid(), label: 'F24 rata 5', type: 'out', amount: 658.38, date: '2026-11-16', certainty: 'certo' },
      { id: uid(), label: 'Secondo acconto', type: 'out', amount: 1138.31, date: '2026-11-30', certainty: 'certo' },
      { id: uid(), label: 'F24 rata 6', type: 'out', amount: 660.47, date: '2026-12-16', certainty: 'certo' },
      { id: uid(), label: 'Mensilità Performa', type: 'in', amount: 1250, recurringDay: 10, certainty: 'certo' },
      { id: uid(), label: 'Spese vita (media 2026, stima)', type: 'out', amount: 1400, recurringDay: 1, certainty: 'certo' },
      { id: uid(), label: 'Gioielli Gentili — rata 1', type: 'in', amount: 550, date: '2026-07-21', certainty: 'probabile' },
      { id: uid(), label: 'Gioielli Gentili — saldo', type: 'in', amount: 550, date: '2026-08-03', certainty: 'probabile' },
      { id: uid(), label: 'Stagionello — saldo', type: 'in', amount: 350, date: '2026-07-24', certainty: 'probabile' },
      { id: uid(), label: 'Bonus Performa Q2', type: 'in', amount: 250, date: '2026-07-27', certainty: 'probabile' },
      { id: uid(), label: 'Gea Pet Shop — rata 1', type: 'in', amount: 400, date: '2026-07-31', certainty: 'incerto' },
      { id: uid(), label: 'Gea Pet Shop — rata 2', type: 'in', amount: 400, date: '2026-08-31', certainty: 'incerto' },
      { id: uid(), label: 'Relief (Enrico)', type: 'in', amount: 390, date: '2026-08-03', certainty: 'incerto' },
      { id: uid(), label: 'Cima del Comè — rata 1', type: 'in', amount: 550, date: '2026-08-17', certainty: 'incerto' },
    ],
  };
}

// ---------- Projection ----------
const DAY = 86400000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const fmtEur = (n: number) =>
  n.toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' €';
const fmtDate = (s: string) => {
  const d = new Date(s + 'T00:00:00');
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
};

type DayPoint = { date: string; certe: number; pipeline: number; events: { label: string; delta: number; sure: boolean }[] };

function project(data: FinanceData): DayPoint[] {
  const start = new Date(data.balanceDate + 'T00:00:00');
  const end = new Date(data.horizonEnd + 'T00:00:00');
  if (!(start < end)) return [];
  const pts: DayPoint[] = [];
  let certe = data.balance;
  let pipeline = data.balance;
  for (let t = start.getTime(); t <= end.getTime(); t += DAY) {
    const d = new Date(t);
    const dISO = iso(d);
    const events: DayPoint['events'] = [];
    for (const it of data.items) {
      const hits = it.recurringDay ? d.getDate() === it.recurringDay : it.date === dISO;
      if (!hits) continue;
      const delta = it.type === 'in' ? it.amount : -it.amount;
      // Prudente: le uscite pesano SEMPRE su entrambi gli scenari; le entrate
      // contano su "certe" solo se certe, su "pipeline" sempre.
      const sure = it.type === 'out' || it.certainty === 'certo';
      if (sure) certe += delta;
      pipeline += delta;
      events.push({ label: it.label, delta, sure });
    }
    pts.push({ date: dISO, certe: Math.round(certe), pipeline: Math.round(pipeline), events });
  }
  return pts;
}

// ---------- Chart ----------
const W = 920, H = 320, M = { top: 16, right: 118, bottom: 28, left: 56 };

function BalanceChart({ pts, target }: { pts: DayPoint[]; target?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { yTicks, y, x, minY } = useMemo(() => {
    const vals = pts.flatMap((p) => [p.certe, p.pipeline]);
    if (target) vals.push(target);
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const span = Math.max(1, hi - lo);
    const step = span > 4000 ? 1000 : span > 2000 ? 500 : 250;
    const loT = Math.floor(lo / step) * step, hiT = Math.ceil(hi / step) * step;
    const ticks: number[] = [];
    for (let v = loT; v <= hiT; v += step) ticks.push(v);
    const y = (v: number) => M.top + (hiT - v) / (hiT - loT || 1) * (H - M.top - M.bottom);
    const x = (i: number) => M.left + (i / Math.max(1, pts.length - 1)) * (W - M.left - M.right);
    return { yTicks: ticks, y, x, minY: lo };
  }, [pts, target]);

  const months = useMemo(() => {
    const out: { i: number; label: string }[] = [];
    pts.forEach((p, i) => {
      if (p.date.endsWith('-01') || i === 0) {
        const d = new Date(p.date + 'T00:00:00');
        out.push({ i, label: d.toLocaleDateString('it-IT', { month: 'short' }) });
      }
    });
    return out;
  }, [pts]);

  const path = (key: 'certe' | 'pipeline') =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');

  const onMove = (e: React.MouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - M.left) / (W - M.left - M.right)) * (pts.length - 1));
    setHover(Math.max(0, Math.min(pts.length - 1, i)));
  };

  if (pts.length < 2) return null;
  const hp = hover != null ? pts[hover] : null;
  const eventDays = pts.map((p, i) => ({ p, i })).filter(({ p }) => p.events.length > 0);
  const last = pts[pts.length - 1];

  return (
    <div className="fin-viz relative w-full">
      <style>{`
        .fin-viz{--fin-s1:#2a78d6;--fin-s2:#008300;--fin-crit:#d03b3b;--fin-grid:#e1e0d9;--fin-axis:#c3c2b7;--fin-muted:#898781;}
        .dark .fin-viz{--fin-s1:#3987e5;--fin-s2:#008300;--fin-crit:#d03b3b;--fin-grid:#2c2c2a;--fin-axis:#383835;}
      `}</style>
      <div className="flex items-center gap-5 text-xs text-muted-foreground mb-1 pl-1">
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-0.5 rounded" style={{ background: 'var(--fin-s1)' }} /> Solo entrate certe</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-0.5 rounded" style={{ background: 'var(--fin-s2)' }} /> Con pipeline</span>
        {minY < 0 && <span className="flex items-center gap-1.5"><AlertTriangle className="w-3 h-3" style={{ color: 'var(--fin-crit)' }} /> sotto zero</span>}
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Proiezione saldo conto"
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)}
              stroke={v === 0 ? 'var(--fin-crit)' : 'var(--fin-grid)'} strokeWidth={1}
              strokeDasharray={v === 0 ? '5 4' : undefined} />
            <text x={M.left - 8} y={y(v) + 3.5} textAnchor="end" fontSize={11} fill="var(--fin-muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {v.toLocaleString('it-IT')}
            </text>
          </g>
        ))}
        {target ? (
          <g>
            <line x1={M.left} x2={W - M.right} y1={y(target)} y2={y(target)} stroke="var(--fin-muted)" strokeWidth={1.5} strokeDasharray="8 5" />
            <text x={W - M.right - 4} y={y(target) - 5} textAnchor="end" fontSize={11} fill="var(--fin-muted)" fontWeight={600}>obiettivo {fmtEur(target)}</text>
          </g>
        ) : null}
        {months.map((m) => (
          <text key={m.i} x={x(m.i)} y={H - 8} fontSize={11} fill="var(--fin-muted)">{m.label}</text>
        ))}
        <line x1={M.left} x2={W - M.right} y1={H - M.bottom} y2={H - M.bottom} stroke="var(--fin-axis)" strokeWidth={1} />
        <path d={path('pipeline')} fill="none" stroke="var(--fin-s2)" strokeWidth={2} strokeLinejoin="round" />
        <path d={path('certe')} fill="none" stroke="var(--fin-s1)" strokeWidth={2} strokeLinejoin="round" />
        {eventDays.map(({ p, i }) => (
          <circle key={i} cx={x(i)} cy={y(p.pipeline)} r={3}
            fill="var(--fin-s2)" stroke="var(--fin-grid)" strokeWidth={1.5} />
        ))}
        <text x={x(pts.length - 1) + 6} y={y(last.certe) + 4} fontSize={11} fill="var(--fin-s1)" fontWeight={600}>
          {fmtEur(last.certe)} certe
        </text>
        <text x={x(pts.length - 1) + 6} y={y(last.pipeline) + (Math.abs(y(last.pipeline) - y(last.certe)) < 14 ? -12 : 4)} fontSize={11} fill="var(--fin-s2)" fontWeight={600}>
          {fmtEur(last.pipeline)} pipeline
        </text>
        {hp && hover != null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={H - M.bottom} stroke="var(--fin-muted)" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(hp.certe)} r={4} fill="var(--fin-s1)" stroke="white" strokeWidth={1.5} />
            <circle cx={x(hover)} cy={y(hp.pipeline)} r={4} fill="var(--fin-s2)" stroke="white" strokeWidth={1.5} />
          </g>
        )}
      </svg>
      {hp && hover != null && (
        <div className="absolute top-8 pointer-events-none z-10 rounded-md border bg-popover text-popover-foreground shadow-md px-3 py-2 text-xs max-w-[260px]"
          style={{ left: `${Math.min(78, (x(hover) / W) * 100)}%` }}>
          <div className="font-semibold mb-1">{fmtDate(hp.date)}</div>
          <div className="flex justify-between gap-4"><span style={{ color: 'var(--fin-s1)' }}>Solo certe</span><span className="tabular-nums">{fmtEur(hp.certe)}</span></div>
          <div className="flex justify-between gap-4"><span style={{ color: 'var(--fin-s2)' }}>Con pipeline</span><span className="tabular-nums">{fmtEur(hp.pipeline)}</span></div>
          {hp.events.map((ev, j) => (
            <div key={j} className="flex justify-between gap-4 mt-1 pt-1 border-t border-border/50">
              <span className="truncate">{ev.label}{ev.sure ? '' : ' *'}</span>
              <span className="tabular-nums">{ev.delta > 0 ? '+' : ''}{fmtEur(ev.delta)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Page ----------
export default function FinancePage() {
  const [data, setData] = useState<FinanceData | null>(null);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'ok'>('idle');

  useEffect(() => {
    api.financeGet().then((r) => setData(r.data && r.data.items ? r.data : seedData())).catch(() => setData(seedData()));
  }, []);

  const save = async (next: FinanceData) => {
    setData(next);
    setSaved('saving');
    try { await api.financeSave(next); setSaved('ok'); setTimeout(() => setSaved('idle'), 1500); }
    catch { setSaved('idle'); }
  };

  const pts = useMemo(() => (data ? project(data) : []), [data]);
  const stats = useMemo(() => {
    if (!data || pts.length === 0) return null;
    let minC = Infinity, minCd = '', minP = Infinity, minPd = '';
    for (const p of pts) {
      if (p.certe < minC) { minC = p.certe; minCd = p.date; }
      if (p.pipeline < minP) { minP = p.pipeline; minPd = p.date; }
    }
    const today = iso(new Date());
    const nextOut = data.items
      .filter((it) => it.type === 'out' && it.date && it.date >= today)
      .sort((a, b) => (a.date! < b.date! ? -1 : 1))[0];
    return { minC, minCd, minP, minPd, nextOut };
  }, [data, pts]);

  if (!data) return <div className="p-6 text-muted-foreground text-sm">Carico…</div>;

  const setItem = (id: string, patch: Partial<FinItem>) =>
    save({ ...data, items: data.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  const delItem = (id: string) => save({ ...data, items: data.items.filter((it) => it.id !== id) });
  const addItem = () =>
    save({ ...data, items: [...data.items, { id: uid(), label: 'Nuovo movimento', type: 'in', amount: 0, date: iso(new Date()), certainty: 'probabile' }] });

  return (
    <div className="space-y-5 max-w-7xl mx-auto p-1">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><Wallet className="w-5 h-5" /> Finanze</h1>
          <p className="text-sm text-muted-foreground">Proiezione saldo contro scadenze fiscali e incassi. Dati solo in locale.</p>
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          {saved === 'saving' ? 'Salvo…' : saved === 'ok' ? <><Check className="w-3 h-3" /> Salvato</> : null}
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Saldo al {fmtDate(data.balanceDate)}</div>
            <div className="text-2xl font-semibold mt-1">{fmtEur(data.balance)}</div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Prossima uscita</div>
            <div className="text-2xl font-semibold mt-1">{stats.nextOut ? fmtEur(stats.nextOut.amount) : '—'}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{stats.nextOut ? `${stats.nextOut.label} · ${fmtDate(stats.nextOut.date!)}` : ''}</div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
              <TrendingDown className="w-3 h-3" /> Minimo solo certe
            </div>
            <div className="text-2xl font-semibold mt-1 flex items-center gap-1.5">
              {stats.minC < 0 && <AlertTriangle className="w-4 h-4" style={{ color: '#d03b3b' }} />}
              {fmtEur(stats.minC)}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">il {fmtDate(stats.minCd)}</div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
              <TrendingUp className="w-3 h-3" /> Minimo con pipeline
            </div>
            <div className="text-2xl font-semibold mt-1 flex items-center gap-1.5">
              {stats.minP < 0 && <AlertTriangle className="w-4 h-4" style={{ color: '#d03b3b' }} />}
              {fmtEur(stats.minP)}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">il {fmtDate(stats.minPd)}</div>
          </Card>
        </div>
      )}

      <Card className="p-4">
        <BalanceChart pts={pts} target={data.target} />
        <p className="text-xs text-muted-foreground mt-2">
          Le uscite pesano sempre su entrambe le linee; le entrate <em>probabili</em> e <em>incerte</em> (segnate * nel dettaglio) solo sulla linea pipeline.
        </p>
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h2 className="text-sm font-semibold">Movimenti</h2>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Saldo attuale</span>
            <Input type="number" className="w-24 h-8" value={data.balance}
              onChange={(e) => save({ ...data, balance: Number(e.target.value) || 0 })} />
            <span className="text-muted-foreground">obiettivo</span>
            <Input type="number" className="w-24 h-8" value={data.target ?? ''} placeholder="—"
              onChange={(e) => save({ ...data, target: Number(e.target.value) || undefined })} />
            <span className="text-muted-foreground">al</span>
            <Input type="date" className="w-36 h-8" value={data.balanceDate}
              onChange={(e) => e.target.value && save({ ...data, balanceDate: e.target.value })} />
            <Button size="sm" variant="outline" onClick={addItem}><Plus className="w-3.5 h-3.5 mr-1" /> Aggiungi</Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground text-left border-b">
                <th className="py-1.5 pr-2 font-medium">Tipo</th>
                <th className="py-1.5 pr-2 font-medium">Descrizione</th>
                <th className="py-1.5 pr-2 font-medium text-right">Importo</th>
                <th className="py-1.5 pr-2 font-medium">Quando</th>
                <th className="py-1.5 pr-2 font-medium">Certezza</th>
                <th className="py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {[...data.items].sort((a, b) => (a.date ?? '0000') < (b.date ?? '0000') ? -1 : 1).map((it) => (
                <tr key={it.id} className="border-b border-border/40 last:border-0">
                  <td className="py-1 pr-2">
                    <Select value={it.type} onValueChange={(v) => setItem(it.id, { type: v as 'in' | 'out' })}>
                      <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="in">Entrata</SelectItem>
                        <SelectItem value="out">Uscita</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="py-1 pr-2 min-w-[200px]">
                    <Input className="h-8" value={it.label} onChange={(e) => setItem(it.id, { label: e.target.value })} />
                  </td>
                  <td className="py-1 pr-2 text-right">
                    <Input type="number" className="h-8 w-24 text-right ml-auto" value={it.amount}
                      onChange={(e) => setItem(it.id, { amount: Math.abs(Number(e.target.value)) || 0 })} />
                  </td>
                  <td className="py-1 pr-2">
                    {it.recurringDay ? (
                      <div className="flex items-center gap-1 text-xs">
                        <span className="text-muted-foreground">ogni</span>
                        <Input type="number" min={1} max={28} className="h-8 w-14" value={it.recurringDay}
                          onChange={(e) => setItem(it.id, { recurringDay: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })} />
                        <button className="text-muted-foreground underline" onClick={() => setItem(it.id, { recurringDay: undefined, date: iso(new Date()) })}>una tantum</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 text-xs">
                        <Input type="date" className="h-8 w-36" value={it.date ?? ''}
                          onChange={(e) => e.target.value && setItem(it.id, { date: e.target.value })} />
                        <button className="text-muted-foreground underline" onClick={() => setItem(it.id, { date: undefined, recurringDay: 10 })}>ricorrente</button>
                      </div>
                    )}
                  </td>
                  <td className="py-1 pr-2">
                    <Select value={it.certainty} onValueChange={(v) => setItem(it.id, { certainty: v as Certainty })}>
                      <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="certo">Certo</SelectItem>
                        <SelectItem value="probabile">Probabile</SelectItem>
                        <SelectItem value="incerto">Incerto</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="py-1 text-right">
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => delItem(it.id)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
