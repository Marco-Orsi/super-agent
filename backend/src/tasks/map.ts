// Mappa cliente -> chat di LETTURA, per il riconoscimento delle task.
//
// Legge `config/client-wa-map.json` e tiene solo i clienti con `wa_read_jid`:
// e' l'identificativo `@lid` con cui WhatsApp registra oggi le chat 1:1, ed e'
// l'unico con cui i messaggi si trovano davvero nel DB. `wa_group_jid` resta il
// canale di INVIO e qui non va usato mai — leggere da li' restituisce zero
// righe (era il difetto che rendeva ciechi tutti i diretti, vedi spec sez. 11).
//
// Una chat puo' servire due clienti (`shared_channel_with`): Alessandra Vegro e'
// la referente sia di La Cimetta Asolo sia di Cima del Pomer. In quel caso ogni
// messaggio ha per definizione due candidati e l'agente deve chiedere, non
// indovinare (spec sez. 5).

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const MAP_PATH = path.resolve(__dirname, '../../config/client-wa-map.json');

export type TaskClient = {
  slug: string;          // identificativo nel brain, mai numeri o JID
  nome: string;          // nome leggibile (nome lista ClickUp o progetto)
  tipo: 'direct' | 'performa';
  readJid: string;       // chat di lettura (@lid)
  readName: string | null;
  sharedWith: string | null; // altro cliente sulla stessa chat
  note: string | null;
};

function slugify(s: string): string {
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function loadReadableClients(): TaskClient[] {
  const raw = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')) as { clients: any[] };
  return raw.clients
    .filter((c) => typeof c.wa_read_jid === 'string' && c.wa_read_jid.length > 0)
    .map((c) => ({
      // brain_slug esiste perche' due chat sono intestate alla persona e non al
      // progetto (Ferdinando Guzzo = Stagionello): derivare lo slug dal nome
      // chat scriverebbe file-task a nome di un contatto.
      slug: c.brain_slug ?? slugify(c.clickup_list_name ?? c.wa_group_name ?? ''),
      nome: c.clickup_list_name ?? c.wa_group_name ?? '',
      tipo: c.client_type === 'direct' ? 'direct' : 'performa',
      readJid: c.wa_read_jid,
      readName: c.wa_read_name ?? null,
      sharedWith: c.shared_channel_with ?? null,
      note: c._note ?? null,
    }));
}

// Tutti i clienti che possono stare dietro a una certa chat. Piu' di uno = ogni
// attribuzione e' ambigua per costruzione.
export function clientsForChat(jid: string, all = loadReadableClients()): TaskClient[] {
  return all.filter((c) => c.readJid === jid);
}

// Le chat da sorvegliare, una per JID anche quando i clienti sono due.
export function readableChats(all = loadReadableClients()): { jid: string; clients: TaskClient[] }[] {
  const byJid = new Map<string, TaskClient[]>();
  for (const c of all) {
    const list = byJid.get(c.readJid) ?? [];
    list.push(c);
    byJid.set(c.readJid, list);
  }
  return [...byJid.entries()].map(([jid, clients]) => ({ jid, clients }));
}
