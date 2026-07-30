// LinkedIn content engine — lettura dei post scritti dal motore contenuti.
//
// I post NON vivono nel database: li scrive la routine delle 9 come file .md
// dentro la wiki (`marketing/linkedin/proposti|bozze`), che è già versionata in
// git. Qui li leggiamo e li parsiamo per la tab LinkedIn del frontend, così la
// pagina resta uno specchio del disco: se la routine gira mentre il Mac è acceso
// e il backend è spento, alla riapertura i post ci sono comunque.
//
// Lo stato di pubblicazione (da pubblicare / pubblicato) invece è nostro e sta
// in settings key `linkedin`, per non riscrivere i file della wiki dal backend.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type PostVerdict = 'PROPONI' | 'BOZZA';

export type LinkedinPost = {
  id: string;              // nome file senza estensione, stabile nel tempo
  file: string;            // path assoluto, per aprirlo dall'editor
  folder: 'proposti' | 'bozze';
  date: string;            // YYYY-MM-DD dal nome file
  title: string;
  pillar: string | null;   // "Pillar 2" ecc.
  technical: boolean;
  verdict: PostVerdict;
  gateNote: string | null; // motivazione del giudice, senza il verdetto
  screenshot: string | null; // schermata da catturare prima di pubblicare
  body: string;            // il testo del post, pronto da copiare
  chars: number;
  updatedAt: string;
};

const DEFAULT_DIR = path.join(os.homedir(), 'Projects', 'llm-wiki', 'marketing', 'linkedin');

export function postsDir(): string {
  return process.env.LINKEDIN_POSTS_DIR || DEFAULT_DIR;
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const COMMENT_RE = /<!--([\s\S]*?)-->/g;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

/**
 * I file sono scritti a mano dal motore, quindi il parser è volutamente
 * tollerante: qualunque pezzo manchi, il post resta leggibile nella tab.
 */
export function parsePost(raw: string, file: string, folder: 'proposti' | 'bozze', mtime: Date): LinkedinPost {
  const id = path.basename(file, '.md');
  const m = DATE_RE.exec(id);

  let text = raw.replace(FRONTMATTER_RE, '');

  // Commenti HTML: il primo che nomina il verdetto è il giudizio del gate,
  // uno che inizia con SCREENSHOT: è l'indicazione della schermata da fare.
  let verdict: PostVerdict | null = null;
  let gateNote: string | null = null;
  let screenshot: string | null = null;
  for (const c of raw.matchAll(COMMENT_RE)) {
    const inner = c[1].trim();
    const shot = /^SCREENSHOT\s*:\s*([\s\S]+)$/i.exec(inner);
    if (shot) {
      screenshot = squash(shot[1]);
      continue;
    }
    const v = /\b(PROPONI|BOZZA)\b/.exec(inner);
    if (v && !verdict) {
      verdict = v[1] as PostVerdict;
      const after = inner.slice(v.index + v[1].length).replace(/^[.\s]+/, '');
      gateNote = squash(after) || null;
    }
  }
  text = text.replace(COMMENT_RE, '');

  const lines = text.split(/\r?\n/);
  let title = '';
  let pillar: string | null = null;
  let technical = false;
  const bodyLines: string[] = [];

  for (const line of lines) {
    const t = line.trim();
    if (!title && t.startsWith('#')) {
      title = t.replace(/^#+\s*/, '');
      continue;
    }
    // riga di metadati subito sotto il titolo: "Pillar 2. Tipo: tecnico, ..."
    if (!bodyLines.length && /^Pillar\s*\d/i.test(t)) {
      pillar = (/^Pillar\s*\d+/i.exec(t) || [null])[0];
      technical = /tecnic/i.test(t);
      continue;
    }
    if (!bodyLines.length && !t) continue; // via le righe vuote in testa
    bodyLines.push(line);
  }

  const body = bodyLines.join('\n').trim();

  return {
    id,
    file,
    folder,
    date: m ? m[1] : mtime.toISOString().slice(0, 10),
    title: title || (m ? m[2].replace(/-/g, ' ') : id),
    pillar,
    technical,
    verdict: verdict ?? (folder === 'proposti' ? 'PROPONI' : 'BOZZA'),
    gateNote,
    screenshot,
    body,
    chars: body.length,
    updatedAt: mtime.toISOString(),
  };
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

async function readFolder(folder: 'proposti' | 'bozze'): Promise<LinkedinPost[]> {
  const dir = path.join(postsDir(), folder);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // cartella non ancora creata: nessun post, non è un errore
  }
  const out: LinkedinPost[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(dir, name);
    try {
      const [raw, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
      out.push(parsePost(raw, file, folder, stat.mtime));
    } catch {
      // un file illeggibile non deve far sparire tutta la tab
    }
  }
  return out;
}

/** Post ordinati dal più recente. `proposti` prima, `bozze` solo se richieste. */
export async function listPosts(includeDrafts = false): Promise<LinkedinPost[]> {
  const folders: ('proposti' | 'bozze')[] = includeDrafts ? ['proposti', 'bozze'] : ['proposti'];
  const all = (await Promise.all(folders.map(readFolder))).flat();
  return all.sort((a, b) => (a.date === b.date ? b.updatedAt.localeCompare(a.updatedAt) : b.date.localeCompare(a.date)));
}
