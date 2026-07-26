// Lettura e scrittura dei file-task nel repo `second-brain-memory`.
// Formato e regole: llm-wiki/operativo/spec-stato-task-brain.md sez. 3.
//
// Una task = un file `tasks/<cliente>--<slug>.md`. Le chiuse vanno in
// `tasks/_archive/`. I file-task NON entrano in MEMORY.md (quell'indice e' gia'
// al limite e le task lo sommergerebbero).
//
// I messaggi non si copiano: si citano per `msg_id` del Postgres locale. Da qui
// discende una proprieta' utile — l'insieme dei msg_id gia' citati nei file-task
// e' anche il registro di cio' che e' gia' stato lavorato, quindi lo scan non ha
// bisogno di un cursore separato che puo' disallinearsi.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';

export const MEMORY_DIR =
  process.env.BRAIN_MEMORY_DIR ??
  path.join(os.homedir(), '.claude/projects/-Users-marcoorsi/memory');

export const TASKS_DIR = path.join(MEMORY_DIR, 'tasks');
export const ARCHIVE_DIR = path.join(TASKS_DIR, '_archive');
export const CANDIDATE_DIR = path.join(TASKS_DIR, '_candidate');
const IGNORED_PATH = path.join(TASKS_DIR, '.scan-ignored.json');

// Valori identici a quelli di ClickUp, cosi' la sincronizzazione e' una copia e
// non una traduzione (spec sez. 3.1).
export const STATI = [
  'to do', 'in progress', 'mandare mex cliente', 'waiting feedback internal',
  'standby', 'waiting feedback client', 'waiting feedback 3rd part',
] as const;
export const STATI_AI = ['da-fare', 'in-lavorazione', 'in-review', 'bloccato'] as const;

export type TaskFile = {
  file: string;          // path assoluto
  cliente: string;
  slug: string;
  stato: string;
  stato_ai: string;
  archiviata: boolean;
  titolo: string;
  msgIds: string[];
};

export function ensureDirs(): void {
  for (const d of [TASKS_DIR, ARCHIVE_DIR, CANDIDATE_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function readTaskFile(file: string, archiviata: boolean): TaskFile | null {
  const parsed = matter(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file, '.md');
  const [cliente, slug] = base.split('--');
  if (!cliente || !slug) return null;
  // Se un file-task viene modificato con gli strumenti di Claude Code, il
  // sistema di memoria lo normalizza a "neurone" e annida i campi sotto
  // `metadata:`. I nostri script scrivono via fs e non lo attivano, ma un
  // agente che passa da Edit sì — e uno stato letto vuoto qui significherebbe
  // task fantasma. Si leggono entrambe le forme.
  const d = { ...(parsed.data.metadata ?? {}), ...parsed.data };
  return {
    file,
    cliente: d.cliente ?? cliente,
    slug,
    stato: d.stato ?? parsed.data.metadata?.stato ?? '',
    stato_ai: d.stato_ai ?? parsed.data.metadata?.stato_ai ?? '',
    archiviata,
    titolo: (parsed.content.match(/^#\s+(.+)$/m)?.[1] ?? slug).trim(),
    // I messaggi sono righe `- \`<msg_id>\` — sintesi`
    msgIds: [...parsed.content.matchAll(/^-\s+`([^`]+)`/gm)].map((m) => m[1]),
  };
}

export function listTasks(): TaskFile[] {
  ensureDirs();
  const out: TaskFile[] = [];
  for (const [dir, arch] of [[TASKS_DIR, false], [ARCHIVE_DIR, true]] as const) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f.startsWith('_')) continue;
      const t = readTaskFile(path.join(dir, f), arch);
      if (t) out.push(t);
    }
  }
  return out;
}

// msg_id gia' agganciati a una task (aperta o archiviata): lo scan li salta.
export function linkedMsgIds(tasks = listTasks()): Set<string> {
  return new Set(tasks.flatMap((t) => t.msgIds));
}

// msg_id visti e scartati da Marco in un giro di apply: senza questo registro
// ogni scan riproporrebbe per sempre gli stessi messaggi che non erano task.
export function ignoredMsgIds(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(IGNORED_PATH, 'utf8')) as string[]);
  } catch {
    return new Set();
  }
}

export function addIgnoredMsgIds(ids: string[]): void {
  ensureDirs();
  const cur = ignoredMsgIds();
  for (const id of ids) cur.add(id);
  fs.writeFileSync(IGNORED_PATH, JSON.stringify([...cur], null, 0) + '\n');
}

export type NewTask = {
  cliente: string;
  slug: string;
  titolo: string;
  stato: string;
  stato_ai: string;
  priorita: string;
  scadenza: string | null;
  requisito: string;
  prossimo_passo: string;
  messaggi: { id: string; sintesi: string }[];
  origine: string;       // da dove e' stata riconosciuta, per la cronologia
};

export function taskPath(cliente: string, slug: string): string {
  return path.join(TASKS_DIR, `${cliente}--${slug}.md`);
}

function renderTask(t: NewTask, oggi: string): string {
  const fm = [
    '---',
    'id_clickup:',                    // vuoto per i diretti
    `cliente: ${t.cliente}`,
    `stato: ${t.stato}`,
    `stato_ai: ${t.stato_ai}`,
    `priorita: ${t.priorita}`,
    `scadenza: ${t.scadenza ?? ''}`,
    'tentativi_ai: 0',
    'last_sync_clickup:',
    'lock:',
    `creata: ${oggi}`,
    'origine: whatsapp',
    '---',
  ].join('\n');

  const messaggi = t.messaggi.length
    ? t.messaggi.map((m) => `- \`${m.id}\` — ${m.sintesi}`).join('\n')
    : '_nessuno_';

  return `${fm}

# ${t.titolo}

## Requisito

${t.requisito}

## Cronologia decisioni

- ${oggi} — Task riconosciuta da ${t.origine}. Nessuna decisione presa.

## Messaggi

${messaggi}

## Deliverable

_da produrre_

## Prossimo passo

${t.prossimo_passo}

## Verdetto grader

_nessun tentativo_
`;
}

// Scrive il file-task. Non sovrascrive mai: sovrascrivere un requisito
// distrugge informazione recuperabile solo scavando nel git (spec sez. 7).
export function writeTask(t: NewTask, oggi: string): { path: string; created: boolean } {
  ensureDirs();
  const p = taskPath(t.cliente, t.slug);
  if (fs.existsSync(p)) return { path: p, created: false };
  fs.writeFileSync(p, renderTask(t, oggi));
  return { path: p, created: true };
}
