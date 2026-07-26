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

// Messaggi che appartengono a una task gia' aperta. Senza questa seconda uscita
// lo scan sapeva solo aprire task nuove, e lo stato di quelle in corso restava
// fermo al giorno in cui erano nate.
export type Update = {
  task: string;            // "cliente--slug", deve esistere
  messaggi: { id: string; sintesi: string }[];
  stato: string | null;
  stato_ai: string | null;
  decisione: string | null;
  prossimo_passo: string | null;
  confidenza: 'alta' | 'media' | 'bassa';
  chiedi: string | null;
  motivo: string;
};

type TaskFileLite = {
  cliente: string; slug: string; titolo: string; stato: string;
  archiviata: boolean; requisito: string; prossimo: string;
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

function buildPrompt(clients: TaskClient[], msgs: WaMsg[], aperte: TaskFileLite[]): string {
  const ambigua = clients.length > 1;
  const elencoClienti = clients
    .map((c) => `- slug: ${c.slug} — ${c.nome}${c.note ? ` (${c.note})` : ''}`)
    .join('\n');

  const elencoAperte = aperte.length
    ? aperte.map((t) => [
        `- id: ${t.cliente}--${t.slug}`,
        `  titolo: ${t.titolo}`,
        `  stato: ${t.stato}${t.archiviata ? ' (ARCHIVIATA, chiusa)' : ''}`,
        `  requisito: ${t.requisito.replace(/\s+/g, ' ').slice(0, 300)}`,
        `  prossimo passo: ${t.prossimo.replace(/\s+/g, ' ').slice(0, 200)}`,
      ].join('\n')).join('\n')
    : '- nessuna';

  return `Sei l'agente che riconosce le task di lavoro dentro una chat WhatsApp di Marco Orsi,
Shopify developer e CRO specialist. Marco è "Marco", l'altro è il cliente.

CLIENTI possibili per questa chat:
${elencoClienti}
${ambigua ? `\n⚠️ Questa chat serve DUE clienti diversi (stessa persona referente). Ogni task ha per
definizione due candidati: NON indovinare. Metti il cliente che ritieni più probabile e compila
"chiedi" con la domanda per Marco.\n` : ''}
TASK GIÀ APERTE nel brain per questi clienti:
${elencoAperte}

MESSAGGI (formato: [msg_id] data mittente: testo)
${fmtMessages(msgs, clients)}

COSA DEVI FARE
Smista ogni messaggio che conta in una di due direzioni.

(A) È una task NUOVA → va in "candidate".
(B) Riguarda una delle task GIÀ APERTE qui sopra → va in "aggiornamenti".

La distinzione conta più di tutto il resto: un messaggio su un lavoro in corso, messo tra le
candidate, crea un doppione della stessa task; un messaggio su un lavoro nuovo, messo tra gli
aggiornamenti, sporca una task che non c'entra. Nel dubbio fra le due, NON scegliere: mettilo
in "aggiornamenti" con "chiedi" compilato, indicando entrambe le letture.

Una task = una cosa da fare o consegnare, con un suo esito. Non sono task i saluti, i convenevoli,
le conferme, i pagamenti già chiusi, le chiacchiere, né i lavori già consegnati e approvati senza
strascichi. Una task già archiviata non si riapre: se un messaggio la riguarda, è una candidata
nuova solo se chiede lavoro nuovo, altrimenti ignorala.

REGOLE PER LE CANDIDATE (A)
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

REGOLE PER GLI AGGIORNAMENTI (B)
- "task" è l'id esatto di una delle task aperte elencate sopra (cliente--slug). Mai inventarne uno.
- "stato" solo se la palla è passata di mano: il cliente ha risposto, ha approvato, ha chiesto
  altro, si è messo in attesa. Se nulla è cambiato, null — non riscrivere lo stesso valore.
- "decisione" è UNA riga, solo se è stata presa una decisione o è cambiato un requisito
  ("il cliente ha scelto la palette avorio", "rimandato a settembre"). Gli eventi normali non
  sono decisioni: quelli stanno già nei messaggi. null se non c'è.
- "prossimo_passo" solo se il passo successivo è cambiato davvero. null altrimenti.
- ⚠️ Se il messaggio CONTRADDICE il requisito già scritto (dice di rifare, tornare indietro,
  annullare qualcosa di già fatto), NON aggiornare da solo: compila "chiedi" spiegando la
  contraddizione. Buttare del lavoro fatto è una decisione di Marco, non tua.
- Il requisito non si riscrive mai da qui: se è cambiato in modo sostanziale, dillo in "chiedi".

Rispondi SOLO con un blocco json, senza testo prima o dopo:

\`\`\`json
{"candidate": [
  {"cliente":"slug-cliente","slug":"kebab-case","titolo":"Titolo breve",
   "stato":"uno dei valori elencati","stato_ai":"da-fare","priorita":"alta|media|bassa",
   "scadenza":null,"requisito":"...","prossimo_passo":"...",
   "messaggi":[{"id":"<msg_id>","sintesi":"..."}],
   "confidenza":"alta","chiedi":null,"motivo":"perché è una task viva"}
],
 "aggiornamenti": [
  {"task":"cliente--slug","messaggi":[{"id":"<msg_id>","sintesi":"..."}],
   "stato":null,"stato_ai":null,"decisione":null,"prossimo_passo":null,
   "confidenza":"alta","chiedi":null,"motivo":"perché appartiene a questa task"}
]}
\`\`\`
Se non c'è niente da riportare, rispondi {"candidate": [], "aggiornamenti": []}.`;
}

function extractJson(text: string): any | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return JSON.parse(raw); } catch { return null; }
}

function renderCandidateFile(cands: Candidate[], ups: Update[], meta: string[]): string {
  const head = `# Task candidate — ${new Date().toISOString().slice(0, 10)}

Due tipi di blocco: \`C\` = task nuova da creare, \`U\` = aggiornamento di una task che esiste già.

Rivedi e correggi. Metti \`approva: false\` su quelle che non sono task: i loro messaggi
finiscono negli ignorati e non tornano più. I blocchi con \`chiedi\` compilato restano in
sospeso: per applicarli svuota il campo \`chiedi\` (dopo aver sistemato cliente o requisito).

Poi: \`npm run tasks:apply -w backend\`

${meta.map((m) => `- ${m}`).join('\n')}
`;

  const blocchiU = ups.map((u, i) => {
    const fm = [
      '---',
      'approva: true',
      `task: ${u.task}`,
      `stato: ${u.stato ?? ''}`,
      `stato_ai: ${u.stato_ai ?? ''}`,
      `confidenza: ${u.confidenza}`,
      `chiedi: ${u.chiedi ? JSON.stringify(u.chiedi) : ''}`,
      'messaggi:',
      ...u.messaggi.map((m) => `  - id: ${m.id}\n    sintesi: ${JSON.stringify(m.sintesi)}`),
      '---',
    ].join('\n');
    const dec = u.decisione ? `\n\n## Decisione\n\n${u.decisione}` : '';
    const pp = u.prossimo_passo ? `\n\n## Prossimo passo\n\n${u.prossimo_passo}` : '';
    return `\n=== U${i + 1} ===\n${fm}${dec}${pp}\n\n## Perché è di questa task\n\n${u.motivo}\n`;
  });

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

  // Prima gli aggiornamenti: riguardano lavoro in corso, quindi vanno letti per
  // primi quando il file e' lungo.
  return head + blocchiU.join('\n') + blocchi.join('\n');
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
  const tuttiUp: Update[] = [];
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
    const aperte: TaskFileLite[] = tasks
      .filter((t) => slugs.has(t.cliente))
      .map((t) => ({
        cliente: t.cliente, slug: t.slug, titolo: t.titolo, stato: t.stato,
        archiviata: t.archiviata, requisito: t.requisito, prossimo: t.prossimo,
      }));
    const idAperte = new Set(aperte.filter((t) => !t.archiviata).map((t) => `${t.cliente}--${t.slug}`));

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
    // Un aggiornamento che punta a una task inesistente non e' recuperabile a
    // valle: apply non saprebbe quale file toccare. Meglio scartarlo qui, dove
    // il motivo finisce nel riepilogo e si vede.
    const ups = ((parsed.aggiornamenti ?? []) as Update[]).filter(
      (u) => u.task && idAperte.has(u.task) && u.messaggi?.length
    );
    const scartate = parsed.candidate.length - cands.length;
    const upScartati = (parsed.aggiornamenti?.length ?? 0) - ups.length;
    meta.push(
      `${etichetta}: ${finestra.length} messaggi letti, ${cands.length} candidate, ${ups.length} aggiornamenti` +
      (scartate ? ` (${scartate} candidate scartate: cliente o slug non validi)` : '') +
      (upScartati ? ` (${upScartati} aggiornamenti scartati: task inesistente)` : '')
    );
    // Lo stato deve restare un valore ClickUp: se il modello inventa, si nota qui
    // e non tre passaggi dopo, dentro un file-task.
    for (const c of cands) {
      if (!STATI.includes(c.stato as any)) c.stato = 'to do';
      if (!STATI_AI.includes(c.stato_ai as any)) c.stato_ai = 'da-fare';
    }
    for (const u of ups) {
      if (u.stato && !STATI.includes(u.stato as any)) u.stato = null;
      if (u.stato_ai && !STATI_AI.includes(u.stato_ai as any)) u.stato_ai = null;
    }
    tutte.push(...cands);
    tuttiUp.push(...ups);
    console.log(`  ${cands.length} candidate, ${ups.length} aggiornamenti`);
  }

  // Un file per esecuzione, mai sovrascritto: due scan nello stesso giorno (per
  // esempio uno per chat) non devono cancellarsi a vicenda. `apply` li legge tutti.
  const base = new Date().toISOString().slice(0, 10);
  let out = path.join(CANDIDATE_DIR, `${base}.md`);
  for (let n = 2; fs.existsSync(out); n++) out = path.join(CANDIDATE_DIR, `${base}-${n}.md`);
  fs.writeFileSync(out, renderCandidateFile(tutte, tuttiUp, meta));
  console.log(`\n${tutte.length} candidate e ${tuttiUp.length} aggiornamenti → ${out}`);
  console.log('Rivedi il file, poi: npm run tasks:apply -w backend');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
