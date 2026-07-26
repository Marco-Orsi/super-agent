// Trascrizione dei vocali WhatsApp delle chat sorvegliate.
//
// Perché serve: nel DB un vocale è una riga con `text = '[audio]'`, quindi per
// qualunque agente che legge le chat quel messaggio non esiste. Su Stagionello
// sono 45 messaggi su 190, e sono proprio quelli in cui il cliente riapre lo
// scope: il primo riconoscimento task ha creato due task sbagliate esattamente
// per questo (vedi tasks/stagionello--product-templates.md).
//
// Come: si scarica il media con Baileys e lo si passa a whisper in locale
// (già installato, nessun servizio esterno), poi si riscrive `text`.
//
// Vincoli deliberati:
// - SOLO le chat mappate in client-wa-map.json. I vocali di famiglia e amici
//   non finiscono trascritti in un database.
// - Coda seriale: whisper satura la CPU, e questo gira sul Mac di lavoro.
// - Non deve mai far fallire l'ingestione: ogni errore resta qui dentro.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import baileysPkg, { type proto } from '@whiskeysockets/baileys';
import { query } from '../../../db/index.js';
import { loadReadableClients } from '../../../tasks/map.js';

const execFileP = promisify(execFile);
const downloadMediaMessage: any = (baileysPkg as any).downloadMediaMessage
  ?? (baileysPkg as any).default?.downloadMediaMessage;

const VOICE_DIR = path.join(os.homedir(), '.super-agent', 'wa-voice');
const WHISPER_BIN = process.env.WHISPER_BIN ?? 'whisper';
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? 'small';
const MAX_SECONDI = 15 * 60;   // oltre, non è un vocale: è una registrazione

let sorvegliate: Set<string> | null = null;
function chatSorvegliata(jid: string): boolean {
  if (!sorvegliate) {
    try {
      sorvegliate = new Set(loadReadableClients().map((c) => c.readJid));
    } catch {
      sorvegliate = new Set();
    }
  }
  return sorvegliate.has(jid);
}

// Coda seriale: un whisper alla volta.
let coda: Promise<void> = Promise.resolve();
function accoda(fn: () => Promise<void>): void {
  coda = coda.then(fn).catch((e) => console.error('[wa:voice]', e?.message ?? e));
}

async function trascrivi(file: string): Promise<string | null> {
  const out = path.dirname(file);
  await execFileP(WHISPER_BIN, [
    file, '--language', 'Italian', '--model', WHISPER_MODEL,
    '--output_format', 'txt', '--output_dir', out, '--fp16', 'False',
  ], { timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  const txt = file.replace(/\.[^.]+$/, '') + '.txt';
  const testo = (await fs.readFile(txt, 'utf8')).trim();
  return testo || null;
}

// Chiamata fire-and-forget da ingestMessage: non si attende e non si propaga.
export function queueVoiceTranscription(
  userId: number,
  msgId: string,
  chatJid: string,
  msg: proto.IWebMessageInfo,
): void {
  const audio = msg.message?.audioMessage;
  if (!audio || !downloadMediaMessage) return;
  if (!chatSorvegliata(chatJid)) return;
  if ((audio.seconds ?? 0) > MAX_SECONDI) return;

  accoda(async () => {
    const file = path.join(VOICE_DIR, `${msgId}.ogg`);
    try {
      await fs.mkdir(VOICE_DIR, { recursive: true });
      const buf: Buffer = await downloadMediaMessage(msg, 'buffer', {});
      await fs.writeFile(file, buf);
      const testo = await trascrivi(file);
      if (!testo) return;
      // Si conserva il marcatore `[audio]`: chi legge deve sapere che è una
      // trascrizione automatica e non le parole scritte dal cliente.
      await query('UPDATE wa_messages SET text=$1 WHERE user_id=$2 AND msg_id=$3',
        [`[audio] ${testo}`, userId, msgId]);
      console.log(`[wa:voice] trascritto ${msgId} (${testo.length} char)`);
    } catch (e: any) {
      console.error(`[wa:voice] fallita trascrizione ${msgId}: ${e?.message ?? e}`);
    }
  });
}
