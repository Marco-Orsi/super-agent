// Apply — crea i file-task dalle candidate approvate da Marco.
//
// Secondo passo dei due: `scan.ts` propone, qui si scrive. La separazione serve
// perché al primo giro tutto è nuovo, e una scrittura diretta produrrebbe decine
// di file da ripulire a mano.
//
// Uso:  npm run tasks:apply -w backend [-- --file <path>] [--dry]
//
// Regole di lettura del file candidate:
// - `approva: true` e `chiedi` vuoto  → crea il file-task
// - `approva: false`                  → i suoi msg_id vanno negli ignorati, così
//                                       lo scan non li ripropone all'infinito
// - `chiedi` compilato                → si salta, senza creare e senza ignorare:
//                                       resta in ballo per il giro dopo. Per
//                                       crearla, svuota `chiedi` e riesegui.

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import {
  CANDIDATE_DIR, addIgnoredMsgIds, appendUpdate, ensureDirs, writeTask,
  type NewTask, type TaskUpdate,
} from './store.js';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

// Tutti i candidate in sospeso, non solo l'ultimo: uno scan per chat produce un
// file per chat, e lasciarne indietro uno significa perdere quelle task.
function candidatePendenti(): string[] {
  ensureDirs();
  return fs.readdirSync(CANDIDATE_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => path.join(CANDIDATE_DIR, f));
}

function sezione(corpo: string, titolo: string): string {
  // `$(?![\s\S])` = fine stringa: in JS non esiste `\Z` e con il flag `m` il
  // solo `$` fermerebbe la sezione alla prima riga vuota.
  const re = new RegExp(`^##\\s+${titolo}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'm');
  return (corpo.match(re)?.[1] ?? '').trim();
}

async function main() {
  const dry = process.argv.includes('--dry');
  const uno = arg('file');
  const files = uno ? [uno] : candidatePendenti();
  if (!files.length || !files.every((f) => fs.existsSync(f))) {
    console.error('Nessun file candidate da applicare. Esegui prima: npm run tasks:scan -w backend');
    process.exit(1);
  }

  const oggi = new Date().toISOString().slice(0, 10);
  const creati: string[] = [];
  const aggiornati: string[] = [];
  const saltate: string[] = [];
  const daIgnorare: string[] = [];
  // Una candidata puo' restare in sospeso (campo `chiedi`): in quel caso il file
  // non va archiviato, altrimenti la domanda sparisce insieme al file.
  const daArchiviare: string[] = [];

  for (const file of files) {
  // Lo split con gruppi di cattura restituisce anche il tipo del blocco:
  // ['testa', 'C', '1', '<blocco>', 'U', '1', '<blocco>', ...]
  const parti = fs.readFileSync(file, 'utf8').split(/^=== ([CU])(\d+) ===\s*$/m);
  const blocchi: { tipo: string; testo: string }[] = [];
  for (let i = 1; i + 2 < parti.length + 1; i += 3) {
    if (parti[i] && parti[i + 2] !== undefined) blocchi.push({ tipo: parti[i], testo: parti[i + 2] });
  }
  let inSospeso = 0;

  for (const { tipo, testo } of blocchi) {
    const { data, content } = matter(testo.trim());
    const nome = tipo === 'U' ? String(data.task ?? '(senza task)') : `${data.cliente}--${data.slug}`;
    const msgIds: string[] = (data.messaggi ?? []).map((m: any) => String(m.id));

    if (data.approva !== true) {
      daIgnorare.push(...msgIds);
      saltate.push(`${nome} — scartata, ${msgIds.length} messaggi negli ignorati`);
      continue;
    }
    if (data.chiedi) {
      inSospeso++;
      saltate.push(`${nome} — in attesa di risposta tua: ${data.chiedi}`);
      continue;
    }

    // --- aggiornamento di una task esistente ---
    if (tipo === 'U') {
      const id = String(data.task ?? '');
      const [cliente, ...resto] = id.split('--');
      const slug = resto.join('--');
      if (!cliente || !slug) {
        saltate.push(`(aggiornamento senza task valida) — ignorato`);
        continue;
      }
      const u: TaskUpdate = {
        cliente, slug,
        messaggi: (data.messaggi ?? []).map((m: any) => ({ id: String(m.id), sintesi: String(m.sintesi ?? '') })),
        stato: data.stato ? String(data.stato) : null,
        stato_ai: data.stato_ai ? String(data.stato_ai) : null,
        decisione: sezione(content, 'Decisione') || null,
        prossimo_passo: sezione(content, 'Prossimo passo') || null,
      };
      if (dry) { console.log(`[dry] aggiornerei ${id}`); continue; }
      const r = appendUpdate(u, oggi);
      if (r.applied) aggiornati.push(`${id} — ${r.nota}`);
      else saltate.push(`${id} — non aggiornata: ${r.nota}`);
      continue;
    }

    if (!data.cliente || !data.slug) {
      saltate.push(`(blocco senza cliente o slug) — ignorato`);
      continue;
    }

    const t: NewTask = {
      cliente: String(data.cliente),
      slug: String(data.slug),
      titolo: String(data.titolo ?? data.slug),
      stato: String(data.stato ?? 'to do'),
      stato_ai: String(data.stato_ai ?? 'da-fare'),
      priorita: String(data.priorita ?? 'media'),
      // YAML trasforma `2026-07-23` in un oggetto Date: senza questo, nel
      // file-task finisce "Thu Jul 23 2026 02:00:00 GMT+0200".
      scadenza: data.scadenza
        ? (data.scadenza instanceof Date
            ? data.scadenza.toISOString().slice(0, 10)
            : String(data.scadenza))
        : null,
      requisito: sezione(content, 'Requisito') || '_da chiarire_',
      prossimo_passo: sezione(content, 'Prossimo passo') || '_da decidere_',
      messaggi: (data.messaggi ?? []).map((m: any) => ({ id: String(m.id), sintesi: String(m.sintesi ?? '') })),
      origine: 'WhatsApp',
    };

    if (dry) { console.log(`[dry] creerei ${nome}`); continue; }
    const { path: p, created } = writeTask(t, oggi);
    if (created) creati.push(path.basename(p));
    else saltate.push(`${nome} — esiste già, non sovrascritto`);
  }

  if (!inSospeso) daArchiviare.push(file);
  else saltate.push(`${path.basename(file)} — resta in _candidate/: ${inSospeso} candidate con domande aperte`);
  }

  if (dry) { console.log('\nDry run: nessuna scrittura.'); process.exit(0); }

  if (daIgnorare.length) addIgnoredMsgIds(daIgnorare);

  // Il candidate lavorato si archivia: se restasse in `_candidate/`, il prossimo
  // apply lo rileggerebbe e proverebbe a ricreare le stesse task.
  const doneDir = path.join(CANDIDATE_DIR, '_done');
  fs.mkdirSync(doneDir, { recursive: true });
  for (const f of daArchiviare) fs.renameSync(f, path.join(doneDir, path.basename(f)));

  console.log(`Create ${creati.length} task:`);
  for (const c of creati) console.log(`  ✓ ${c}`);
  if (aggiornati.length) {
    console.log(`\nAggiornate ${aggiornati.length} task esistenti:`);
    for (const a of aggiornati) console.log(`  ↻ ${a}`);
  }
  if (saltate.length) {
    console.log(`\nNon create (${saltate.length}):`);
    for (const s of saltate) console.log(`  · ${s}`);
  }
  if (daArchiviare.length) {
    console.log(`\n${daArchiviare.length} file candidate archiviati in ${path.relative(process.cwd(), doneDir)}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
