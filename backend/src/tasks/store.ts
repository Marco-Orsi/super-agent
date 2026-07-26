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
  requisito: string;     // serve allo scan per capire se un messaggio nuovo e' di questa task
  prossimo: string;
};

// Testo di una sezione `## Titolo`, senza il titolo.
function sezioneTesto(corpo: string, titolo: string): string {
  const re = new RegExp(`^##\\s+${titolo}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'm');
  return (corpo.match(re)?.[1] ?? '').trim();
}

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
    requisito: sezioneTesto(parsed.content, 'Requisito'),
    prossimo: sezioneTesto(parsed.content, 'Prossimo passo'),
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

// ---------------------------------------------------------------------------
// Aggiornamento di una task che esiste gia'.
//
// Senza questo, il sistema sapeva solo aprire: un messaggio su un lavoro in
// corso non agganciava e lo `stato` restava quello del giorno in cui la task era
// nata. Con le task del giovedi ancora aperte il lunedi, e' la meta' del lavoro.
//
// Si scrive per aggiunta, mai per sostituzione — tranne `Prossimo passo`, che per
// natura descrive un solo istante: quando cambia, il vecchio non si perde perche'
// il cambio finisce in `Cronologia decisioni`. Il `Requisito` non si tocca mai.

export type TaskUpdate = {
  cliente: string;
  slug: string;
  messaggi: { id: string; sintesi: string }[];
  stato: string | null;          // null = invariato
  stato_ai: string | null;       // null = invariato
  decisione: string | null;      // una riga per la cronologia, se e' stata presa
  prossimo_passo: string | null; // null = invariato
};

// Confini di una sezione `## Titolo`: dal titolo al prossimo `##` o a fine file.
function sectionRange(body: string, titolo: string): { start: number; end: number } | null {
  // `[ \t]*` e non `\s*`: `\s` include il newline, se lo consuma il punto di
  // inserimento finisce una riga piu' sotto e ogni giro aggiunge una riga vuota.
  const re = new RegExp(`^##\\s+${titolo}[ \\t]*$`, 'm');
  const m = body.match(re);
  if (m?.index === undefined) return null;
  const start = m.index + m[0].length;
  const next = body.slice(start).search(/^##\s+/m);
  return { start, end: next === -1 ? body.length : start + next };
}

function appendToSection(body: string, titolo: string, righe: string[]): string {
  const r = sectionRange(body, titolo);
  if (!r || !righe.length) return body;
  // I placeholder (`_nessuno_`, `_da produrre_`) vanno sostituiti, non affiancati.
  const dentro = body.slice(r.start, r.end).replace(/^\s*_[^_\n]+_\s*$/m, '').trimEnd();
  const nuovo = `${dentro}\n${righe.join('\n')}\n\n`;
  return body.slice(0, r.start) + '\n\n' + nuovo.trimStart() + body.slice(r.end);
}

function replaceSection(body: string, titolo: string, testo: string): string {
  const r = sectionRange(body, titolo);
  if (!r) return body;
  return body.slice(0, r.start) + `\n\n${testo.trim()}\n\n` + body.slice(r.end);
}

function setFrontmatterField(raw: string, campo: string, valore: string): string {
  const fmEnd = raw.indexOf('\n---', 4);
  if (!raw.startsWith('---') || fmEnd === -1) return raw;
  const fm = raw.slice(0, fmEnd);
  const resto = raw.slice(fmEnd);
  const re = new RegExp(`^${campo}:.*$`, 'm');
  if (!re.test(fm)) return raw;
  return fm.replace(re, `${campo}: ${valore}`) + resto;
}

export function appendUpdate(
  u: TaskUpdate,
  oggi: string
): { path: string; applied: boolean; nota: string } {
  const p = taskPath(u.cliente, u.slug);
  if (!fs.existsSync(p)) return { path: p, applied: false, nota: 'file-task non trovato' };

  let raw = fs.readFileSync(p, 'utf8');
  const gia = new Set([...raw.matchAll(/^-\s+`([^`]+)`/gm)].map((m) => m[1]));
  const nuovi = u.messaggi.filter((m) => !gia.has(m.id));
  const cambi: string[] = [];

  const fmEnd = raw.indexOf('\n---', 4) + 4;
  let body = raw.slice(fmEnd);

  if (nuovi.length) {
    body = appendToSection(body, 'Messaggi', nuovi.map((m) => `- \`${m.id}\` — ${m.sintesi}`));
    cambi.push(`${nuovi.length} messaggi`);
  }

  // Uno stato riscritto uguale non e' un cambio: senza questo controllo ogni
  // giro aggiungerebbe una riga di cronologia che racconta una transizione mai
  // avvenuta, e la cronologia serve proprio a distinguere cosa e' cambiato.
  const statoAttuale = raw.match(/^stato:\s*(.*)$/m)?.[1]?.trim() ?? '';
  const statoAiAttuale = raw.match(/^stato_ai:\s*(.*)$/m)?.[1]?.trim() ?? '';
  const statoOk =
    u.stato && STATI.includes(u.stato as any) && u.stato !== statoAttuale ? u.stato : null;
  const statoAiOk =
    u.stato_ai && STATI_AI.includes(u.stato_ai as any) && u.stato_ai !== statoAiAttuale
      ? u.stato_ai
      : null;

  const cronologia: string[] = [];
  // Una decisione gia' scritta non si riscrive: due giri di apply sullo stesso
  // candidate (o un rilancio dopo una correzione) la duplicherebbero.
  const decisioneNuova =
    u.decisione && !body.includes(u.decisione.trim()) ? u.decisione.trim() : null;
  if (decisioneNuova) cronologia.push(`- ${oggi} — ${decisioneNuova}`);
  if (statoOk) cronologia.push(`- ${oggi} — Stato → ${statoOk}, dai messaggi nuovi.`);
  if (u.prossimo_passo) {
    // Il vecchio prossimo passo sparirebbe senza lasciare traccia: la cronologia
    // e' l'unico posto dove resta leggibile senza aprire il git log.
    const vecchio = sectionRange(body, 'Prossimo passo');
    const testoVecchio = vecchio ? body.slice(vecchio.start, vecchio.end).trim() : '';
    if (testoVecchio !== u.prossimo_passo.trim()) {
      if (testoVecchio) {
        cronologia.push(`- ${oggi} — Prossimo passo era: ${testoVecchio.replace(/\s+/g, ' ')}`);
      }
      body = replaceSection(body, 'Prossimo passo', u.prossimo_passo);
      cambi.push('prossimo passo');
    }
  }
  if (cronologia.length) body = appendToSection(body, 'Cronologia decisioni', cronologia);
  if (decisioneNuova) cambi.push('decisione');

  raw = raw.slice(0, fmEnd) + body;
  if (statoOk) { raw = setFrontmatterField(raw, 'stato', statoOk); cambi.push(`stato → ${statoOk}`); }
  if (statoAiOk) { raw = setFrontmatterField(raw, 'stato_ai', statoAiOk); cambi.push(`stato_ai → ${statoAiOk}`); }

  if (!cambi.length) return { path: p, applied: false, nota: 'niente di nuovo da aggiungere' };
  fs.writeFileSync(p, raw);
  return { path: p, applied: true, nota: cambi.join(', ') };
}
