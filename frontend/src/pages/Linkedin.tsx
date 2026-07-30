import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLinkedin } from '@fortawesome/free-brands-svg-icons';
import {
  Copy, Check, CheckCheck, RotateCcw,
  ChevronDown, ChevronRight, Camera, FileText, Inbox,
} from 'lucide-react';

type Post = {
  id: string;
  file: string;
  folder: 'proposti' | 'bozze';
  date: string;
  title: string;
  pillar: string | null;
  technical: boolean;
  verdict: 'PROPONI' | 'BOZZA';
  gateNote: string | null;
  screenshot: string | null;
  body: string;
  chars: number;
  status: 'ready' | 'published';
  publishedAt: string | null;
};

const fmtDate = (s: string) => {
  const d = new Date(s + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
};

export default function LinkedinPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [dir, setDir] = useState('');
  const [drafts, setDrafts] = useState(false);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [openGate, setOpenGate] = useState<Record<string, boolean>>({});

  const load = useCallback(async (withDrafts: boolean) => {
    setLoading(true);
    try {
      const r = await api.linkedinPosts(withDrafts);
      setPosts(r.posts as Post[]);
      setDir(r.dir);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(drafts); }, [drafts, load]);

  const ready = useMemo(() => posts.filter((p) => p.folder === 'proposti' && p.status === 'ready'), [posts]);
  const published = useMemo(() => posts.filter((p) => p.status === 'published'), [posts]);

  async function toggleStatus(p: Post) {
    const next = p.status === 'published' ? 'ready' : 'published';
    setPosts((cur) => cur.map((x) => (x.id === p.id ? { ...x, status: next, publishedAt: next === 'published' ? new Date().toISOString() : null } : x)));
    try {
      await api.linkedinSetStatus(p.id, next);
    } catch {
      load(drafts); // il server ha rifiutato: si rilegge la verità dal disco
    }
  }

  async function copy(p: Post) {
    await navigator.clipboard.writeText(p.body);
    setCopied(p.id);
    setTimeout(() => setCopied((c) => (c === p.id ? null : c)), 1800);
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <FontAwesomeIcon icon={faLinkedin} style={{ width: 20, height: 20 }} />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">LinkedIn</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Post scritti dal lavoro reale e passati dal gate. Approvi, copi, pubblichi.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant={drafts ? 'default' : 'outline'} size="sm" onClick={() => setDrafts((d) => !d)}>
            <Inbox className="h-4 w-4" />
            {drafts ? 'Nascondi bozze' : 'Mostra bozze'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => load(drafts)} disabled={loading}>
            <RotateCcw className="h-4 w-4" />
            Aggiorna
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Da pubblicare" value={ready.length} />
        <Stat label="Pubblicati" value={published.length} />
        <Stat label="Totale scritti" value={posts.length} />
      </div>

      {loading && posts.length === 0 && (
        <p className="text-sm text-muted-foreground">Carico i post…</p>
      )}

      {!loading && posts.length === 0 && (
        <Card>
          <div className="p-6 space-y-2">
            <p className="text-sm">Nessun post ancora.</p>
            <p className="text-xs text-muted-foreground">
              Il motore scrive qui dentro: <code className="font-mono">{dir}</code>
            </p>
          </div>
        </Card>
      )}

      <div className="space-y-4">
        {posts.map((p) => {
          const isDraft = p.folder === 'bozze';
          const gateOpen = !!openGate[p.id];
          return (
            <Card key={p.id} className={p.status === 'published' ? 'opacity-70' : undefined}>
              <div className="p-5 space-y-4">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="space-y-1.5">
                    <h2 className="text-lg font-semibold leading-tight">{p.title}</h2>
                    <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                      <span>{fmtDate(p.date)}</span>
                      {p.pillar && <Badge variant="secondary">{p.pillar}</Badge>}
                      {p.technical && <Badge variant="outline">tecnico</Badge>}
                      {isDraft && <Badge variant="outline">bozza, non passata al gate</Badge>}
                      <span>{p.chars} caratteri</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => copy(p)}>
                      {copied === p.id ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {copied === p.id ? 'Copiato' : 'Copia'}
                    </Button>
                    {!isDraft && (
                      <Button size="sm" variant={p.status === 'published' ? 'outline' : 'default'} onClick={() => toggleStatus(p)}>
                        <CheckCheck className="h-4 w-4" />
                        {p.status === 'published' ? 'Rimetti da pubblicare' : 'Segna pubblicato'}
                      </Button>
                    )}
                  </div>
                </div>

                <p className="whitespace-pre-wrap text-sm leading-relaxed">{p.body}</p>

                {p.screenshot && (
                  <div className="flex items-start gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    <Camera className="h-4 w-4 shrink-0 mt-0.5" />
                    <span><span className="font-medium">Schermata da fare: </span>{p.screenshot}</span>
                  </div>
                )}

                <div className="border-t pt-3 space-y-2">
                  <button
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setOpenGate((o) => ({ ...o, [p.id]: !o[p.id] }))}
                  >
                    {gateOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    Verdetto del giudice: <span className="font-medium">{p.verdict}</span>
                  </button>
                  {gateOpen && (
                    <div className="space-y-2 text-xs text-muted-foreground">
                      <p>{p.gateNote || 'Nessuna nota.'}</p>
                      <p className="flex items-center gap-1.5 font-mono break-all">
                        <FileText className="h-3.5 w-3.5 shrink-0" />
                        {p.file}
                      </p>
                    </div>
                  )}
                  {p.status === 'published' && p.publishedAt && (
                    <p className="text-xs text-muted-foreground">
                      Pubblicato il {new Date(p.publishedAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}
                    </p>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <div className="p-4 space-y-1">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
      </div>
    </Card>
  );
}
