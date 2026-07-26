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
import { CANDIDATE_DIR, addIgnoredMsgIds, ensureDirs, writeTask, type NewTask } from './store.js';

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
  const saltate: string[] = [];
  const daIgnorare: string[] = [];
  // Una candidata puo' restare in sospeso (campo `chiedi`): in quel caso il file
  // non va archiviato, altrimenti la domanda sparisce insieme al file.
  const daArchiviare: string[] = [];

  for (const file of files) {
  const blocchi = fs.readFileSync(file, 'utf8').split(/^=== C\d+ ===\s*$/m).slice(1);
  let inSospeso = 0;

  for (const blocco of blocchi) {
    const { data, content } = matter(blocco.trim());
    const nome = `${data.cliente}--${data.slug}`;
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
  if (saltate.length) {
    console.log(`\nNon create (${saltate.length}):`);
    for (const s of saltate) console.log(`  · ${s}`);
  }
  console.log(`\nCandidate archiviate in ${path.relative(process.cwd(), doneDir)}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
