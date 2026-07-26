// Scan — riconosce le task candidate dai messaggi WhatsApp dei clienti mappati.
//
// Per i clienti diretti la task non si "crea": nasce in un canale e va
// riconosciuta (spec sez. 2). Questo script fa il primo passo dei due: legge le
// chat sorvegliate, chiede a Claude quali task ci sono dentro e scrive le
// candidate in `tasks/_candidate/<data>.md`. NON tocca i file-task: quelli li
// crea `apply.ts` dopo che Marco ha rivisto il file.
//
// Uso:  npm run tasks:scan -w backend [-- --days 50] [--chat <jid>]
//
// Cosa NON fa di proposito: non scrive su ClickUp, non manda niente a nessuno,
// non aggiorna task esistenti. E' il pilota "solo dentro il brain" (spec 10).

import fs from 'node:fs';
import path from 'node:path';
import { query } from '../db/index.js';
import { runClaude } from '../claude/runner.js';
import { readableChats, type TaskClient } from './map.js';
import {
  CANDIDATE_DIR, ensureDirs, ignoredMsgIds, linkedMsgIds, listTasks,
  STATI, STATI_AI,
} from './store.js';

const USER_ID = Number(process.env.TASKS_USER_ID ?? 1);
const MAX_MSG_PER_CHAT = 400; // oltre, il prompt diventa ingestibile

type WaMsg = {
  msg_id: string;
  sender_name: string | null;
  from_me: boolean;
  text: string;
  ts: Date;
};

export type Candidate = {
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
  confidenza: 'alta' | 'media' | 'bassa';
  chiedi: string | null;   // domanda a Marco quando l'attribuzione e' ambigua
  motivo: string;          // perche' l'agente la considera una task
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function fetchMessages(jid: string, days: number): Promise<WaMsg[]> {
  return query<WaMsg>(
    `SELECT msg_id, sender_name, from_me, text, ts
       FROM wa_messages
      WHERE user_id = $1 AND chat_jid = $2
        AND ts > now() - ($3 || ' days')::interval
        AND text <> ''
      ORDER BY ts ASC`,
    [USER_ID, jid, String(days)]
  );
}

function fmtMessages(msgs: WaMsg[], clients: TaskClient[]): string {
  const altro = clients[0]?.readName ?? 'cliente';
  return msgs
    .map((m) => {
      const chi = m.from_me ? 'Marco' : (m.sender_name || altro);
      const quando = new Date(m.ts).toISOString().slice(0, 16).replace('T', ' ');
      return `[${m.msg_id}] ${quando} ${chi}: ${m.text.replace(/\s+/g, ' ').trim()}`;
    })
    .join('\n');
}

function buildPrompt(clients: TaskClient[], msgs: WaMsg[], aperte: string[]): string {
  const ambigua = clients.length > 1;
  const elencoClienti = clients
    .map((c) => `- slug: ${c.slug} — ${c.nome}${c.note ? ` (${c.note})` : ''}`)
    .join('\n');

  return `Sei l'agente che riconosce le task di lavoro dentro una chat WhatsApp di Marco Orsi,
Shopify developer e CRO specialist. Marco è "Marco", l'altro è il cliente.

CLIENTI possibili per questa chat:
${elencoClienti}
${ambigua ? `\n⚠️ Questa chat serve DUE clienti diversi (stessa persona referente). Ogni task ha per
definizione due candidati: NON indovinare. Metti il cliente che ritieni più probabile e compila
"chiedi" con la domanda per Marco.\n` : ''}
TASK GIÀ ESISTENTI nel brain per questi clienti (non riproporle, servono solo a evitare doppioni):
${aperte.length ? aperte.map((a) => `- ${a}`).join('\n') : '- nessuna'}

MESSAGGI (formato: [msg_id] data mittente: testo)
${fmtMessages(msgs, clients)}

COSA DEVI FARE
Individua le unità di lavoro richieste a Marco in questa chat: una task = una cosa da fare o
consegnare, con un suo esito. Non sono task i saluti, i convenevoli, le conferme, i pagamenti
già chiusi, le chiacchiere, né i lavori già consegnati e approvati senza strascichi.

Regole:
- Una task che ha già ricevuto il suo "ok va bene" e non ha code aperte NON va proposta.
- Se più messaggi riguardano lo stesso lavoro, sono UNA task sola con più msg_id.
- Cita in "messaggi" solo i msg_id che riguardano davvero quella task, con una riga di sintesi.
- "stato" descrive chi ha la palla ORA, guardando l'ultimo messaggio: ${STATI.join(' | ')}
- "stato_ai" è a che punto è l'agente, per una task appena riconosciuta è sempre: da-fare
- "slug" è kebab-case corto e parlante del lavoro (es. judgeme-recensioni, pagina-itinerari).
- "requisito" è cosa va fatto, in 2-4 righe, con le parole del cliente dove contano. Se il
  cliente ha detto una cifra, una data o un sì esplicito, cita la frase tra virgolette.
- "confidenza" è quanto sei sicuro che sia una task viva: alta | media | bassa.
- "chiedi" è la domanda a Marco quando qualcosa non è deducibile dai messaggi (a quale cliente
  attribuirla, se è ancora aperta, cosa intendeva). null se non serve chiedere.

Rispondi SOLO con un blocco json, senza testo prima o dopo:

\`\`\`json
{"candidate": [
  {"cliente":"slug-cliente","slug":"kebab-case","titolo":"Titolo breve",
   "stato":"uno dei valori elencati","stato_ai":"da-fare","priorita":"alta|media|bassa",
   "scadenza":null,"requisito":"...","prossimo_passo":"...",
   "messaggi":[{"id":"<msg_id>","sintesi":"..."}],
   "confidenza":"alta","chiedi":null,"motivo":"perché è una task viva"}
]}
\`\`\`
Se non c'è nessuna task viva, rispondi {"candidate": []}.`;
}

function extractJson(text: string): any | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return JSON.parse(raw); } catch { return null; }
}

function renderCandidateFile(cands: Candidate[], meta: string[]): string {
  const head = `# Task candidate — ${new Date().toISOString().slice(0, 10)}

Rivedi e correggi. Metti \`approva: false\` su quelle che non sono task: i loro messaggi
finiscono negli ignorati e non tornano più. Le candidate con \`chiedi\` compilato restano in
sospeso: per crearle svuota il campo \`chiedi\` (dopo aver sistemato cliente o requisito).

Poi: \`npm run tasks:apply -w backend\`

${meta.map((m) => `- ${m}`).join('\n')}
`;

  const blocchi = cands.map((c, i) => {
    const fm = [
      '---',
      'approva: true',
      `cliente: ${c.cliente}`,
      `slug: ${c.slug}`,
      `titolo: ${JSON.stringify(c.titolo)}`,
      `stato: ${c.stato}`,
      `stato_ai: ${c.stato_ai}`,
      `priorita: ${c.priorita}`,
      `scadenza: ${c.scadenza ?? ''}`,
      `confidenza: ${c.confidenza}`,
      `chiedi: ${c.chiedi ? JSON.stringify(c.chiedi) : ''}`,
      'messaggi:',
      ...c.messaggi.map((m) => `  - id: ${m.id}\n    sintesi: ${JSON.stringify(m.sintesi)}`),
      '---',
    ].join('\n');
    return `\n=== C${i + 1} ===\n${fm}\n\n## Requisito\n\n${c.requisito}\n\n## Prossimo passo\n\n${c.prossimo_passo}\n\n## Perché è una task\n\n${c.motivo}\n`;
  });

  return head + blocchi.join('\n');
}

async function main() {
  const days = Number(arg('days') ?? 50);
  const soloChat = arg('chat');
  ensureDirs();

  const tasks = listTasks();
  const linked = linkedMsgIds(tasks);
  const ignored = ignoredMsgIds();
  const chats = readableChats().filter((c) => !soloChat || c.jid === soloChat);

  const tutte: Candidate[] = [];
  const meta: string[] = [];

  for (const { jid, clients } of chats) {
    const etichetta = clients.map((c) => c.slug).join(' + ');
    const all = await fetchMessages(jid, days);
    const nuovi = all.filter((m) => !linked.has(m.msg_id) && !ignored.has(m.msg_id));
    if (!nuovi.length) {
      meta.push(`${etichetta}: nessun messaggio nuovo negli ultimi ${days} giorni`);
      console.log(`— ${etichetta}: 0 messaggi nuovi`);
      continue;
    }
    const finestra = nuovi.slice(-MAX_MSG_PER_CHAT);
    if (finestra.length < nuovi.length) {
      meta.push(`⚠️ ${etichetta}: letti solo gli ultimi ${MAX_MSG_PER_CHAT} messaggi su ${nuovi.length}`);
    }

    const slugs = new Set(clients.map((c) => c.slug));
    const aperte = tasks
      .filter((t) => slugs.has(t.cliente))
      .map((t) => `${t.cliente}--${t.slug} — ${t.titolo} [${t.stato}${t.archiviata ? ', archiviata' : ''}]`);

    console.log(`— ${etichetta}: ${finestra.length} messaggi → Claude…`);
    const res = await runClaude(USER_ID, buildPrompt(clients, finestra, aperte), {
      useMcp: false,
      allowedTools: ['Read'],
      kind: 'task-scan',
      meta: { chat: jid, clienti: [...slugs] },
      timeoutMs: 10 * 60_000,
    });

    if (!res.ok) {
      meta.push(`❌ ${etichetta}: run fallito (${res.diagnosis?.title ?? res.exitCode})`);
      console.error(`  errore: ${res.diagnosis?.title ?? res.stderr.slice(0, 200)}`);
      continue;
    }
    const parsed = extractJson(res.text);
    if (!parsed?.candidate) {
      meta.push(`❌ ${etichetta}: risposta non interpretabile`);
      console.error('  risposta non JSON:', res.text.slice(0, 300));
      continue;
    }
    const cands = (parsed.candidate as Candidate[]).filter(
      (c) => slugs.has(c.cliente) && c.slug && c.messaggi?.length
    );
    const scartate = parsed.candidate.length - cands.length;
    meta.push(
      `${etichetta}: ${finestra.length} messaggi letti, ${cands.length} candidate` +
      (scartate ? ` (${scartate} scartate: cliente o slug non validi)` : '')
    );
    // Lo stato deve restare un valore ClickUp: se il modello inventa, si nota qui
    // e non tre passaggi dopo, dentro un file-task.
    for (const c of cands) {
      if (!STATI.includes(c.stato as any)) c.stato = 'to do';
      if (!STATI_AI.includes(c.stato_ai as any)) c.stato_ai = 'da-fare';
    }
    tutte.push(...cands);
    console.log(`  ${cands.length} candidate`);
  }

  // Un file per esecuzione, mai sovrascritto: due scan nello stesso giorno (per
  // esempio uno per chat) non devono cancellarsi a vicenda. `apply` li legge tutti.
  const base = new Date().toISOString().slice(0, 10);
  let out = path.join(CANDIDATE_DIR, `${base}.md`);
  for (let n = 2; fs.existsSync(out); n++) out = path.join(CANDIDATE_DIR, `${base}-${n}.md`);
  fs.writeFileSync(out, renderCandidateFile(tutte, meta));
  console.log(`\n${tutte.length} candidate totali → ${out}`);
  console.log('Rivedi il file, poi: npm run tasks:apply -w backend');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
