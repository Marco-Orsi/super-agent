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
import os from 'node:os';
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
  theme: ClientTheme | null; // dove vive il codice, null se il cliente non ha tema
};

// Dove lavorare per quel cliente. Senza questo dato un file-task descrive un
// lavoro da fare ma non dice a nessun agente su quale repo e quale store farlo:
// e' il pezzo che manca per passare dal riconoscere all'eseguire.
export type ClientTheme = {
  repo: string | null;      // "Marco-Orsi/shopify-<cliente>"
  path: string;             // copia canonica locale, gia' espansa
  branch: string | null;    // ramo che rispecchia il live
  env: string | null;       // environment della CLI Shopify
  store: string | null;     // dominio myshopify, per quando env non c'e'
  verified: boolean;        // false = manca un dato: fermarsi e chiedere
  note: string | null;      // avvertenze specifiche di quel tema
};

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function readTheme(raw: any): ClientTheme | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    repo: raw.repo ?? null,
    path: expandHome(String(raw.path ?? '')),
    branch: raw.branch ?? null,
    env: raw.env ?? null,
    store: raw.store ?? null,
    verified: raw.verified === true,
    note: raw._note ?? null,
  };
}

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
      theme: readTheme(c.theme),
    }));
}

// Tutti i clienti della mappa, anche quelli senza chat di lettura: il tema
// serve pure ai clienti che non hanno (ancora) un canale WhatsApp sorvegliato.
export function loadAllClients(): TaskClient[] {
  const raw = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')) as { clients: any[] };
  return raw.clients.map((c) => ({
    slug: c.brain_slug ?? slugify(c.clickup_list_name ?? c.wa_group_name ?? ''),
    nome: c.clickup_list_name ?? c.wa_group_name ?? '',
    tipo: c.client_type === 'direct' ? 'direct' : 'performa',
    readJid: c.wa_read_jid ?? '',
    readName: c.wa_read_name ?? null,
    sharedWith: c.shared_channel_with ?? null,
    note: c._note ?? null,
    theme: readTheme(c.theme),
  }));
}

// Il tema di un cliente, per slug del brain. null quando il cliente non ne ha
// uno mappato: chi chiama deve fermarsi, non tirare a indovinare una cartella.
export function themeForClient(slug: string, all = loadAllClients()): ClientTheme | null {
  return all.find((c) => c.slug === slug)?.theme ?? null;
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
