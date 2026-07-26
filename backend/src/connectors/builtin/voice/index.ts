import type { Connector } from '../../types.js';
import { query } from '../../../db/index.js';

const PRICE_PER_SEC: Record<string, number> = {
  'whisper-1':                  0.006 / 60,
  'whisper-large-v3':           0.00185 / 60,
  'whisper-large-v3-turbo':     0.00067 / 60,
  'distil-whisper-large-v3-en': 0.00033 / 60,
};
function estimateCost(model: string, seconds: number): number | null {
  const rate = PRICE_PER_SEC[model];
  return rate != null ? Number((rate * seconds).toFixed(6)) : null;
}

export type VoiceConfig = {
  provider?: 'openai' | 'groq' | 'custom' | 'local';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  language?: string;
  /** Solo provider 'local': percorso del binario whisper. */
  binPath?: string;
};

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  groq:   { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
  custom: { baseUrl: '', model: 'whisper-1' },
  local:  { baseUrl: '', model: 'small' },
};

const LOCAL_WHISPER_DEFAULT = '/Library/Frameworks/Python.framework/Versions/3.11/bin/whisper';

/**
 * Trascrizione con whisper installato sulla macchina: nessuna chiave, nessun costo,
 * l'audio non esce dal Mac. Gira su CPU, quindi è lento in proporzione alla durata
 * (un vocale di 30s richiede una ventina di secondi).
 */
async function transcribeLocal(
  buf: Buffer,
  filename: string,
  cfg: VoiceConfig,
): Promise<string> {
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const bin = cfg.binPath || LOCAL_WHISPER_DEFAULT;
  const model = cfg.model || PROVIDER_DEFAULTS.local.model;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-voice-'));
  const safeName = filename.replace(/[^\w.-]/g, '_') || 'audio.ogg';
  const audioPath = path.join(dir, safeName);

  try {
    await fs.writeFile(audioPath, buf);
    const args = [audioPath, '--model', model, '--output_format', 'txt', '--output_dir', dir, '--verbose', 'False'];
    if (cfg.language) args.push('--language', cfg.language);
    await run(bin, args, { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });

    const base = safeName.replace(/\.[^.]+$/, '');
    const out = await fs.readFile(path.join(dir, `${base}.txt`), 'utf8');
    return out.trim();
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function getVoiceConfig(userId: number): Promise<VoiceConfig> {
  const rows = await query<{ config: any; enabled: boolean }>(
    `SELECT config, enabled FROM connectors WHERE user_id=$1 AND name='voice'`, [userId]
  );
  const row = rows[0];
  if (!row?.enabled) return {};
  return row.config ?? {};
}

export async function transcribeBuffer(
  userId: number,
  buf: Buffer,
  filename: string,
  mime: string,
  audioSeconds?: number,
): Promise<{ text: string; cost?: number | null; model: string; provider: string }> {
  const cfg = await getVoiceConfig(userId);
  const provider = cfg.provider ?? 'openai';
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.openai;
  const baseUrl = cfg.baseUrl || defaults.baseUrl;
  const model = cfg.model || defaults.model;
  const apiKey = cfg.apiKey;
  const isLocal = provider === 'local';
  if (!isLocal && !apiKey) throw new Error('voice connector: apiKey missing');
  if (!isLocal && !baseUrl) throw new Error('voice connector: baseUrl missing');

  // Percorso locale: whisper sulla macchina, niente rete, niente costo.
  if (isLocal) {
    const started = Date.now();
    let ok = false;
    let text = '';
    let errMsg: string | null = null;
    try {
      text = await transcribeLocal(buf, filename, cfg);
      ok = true;
    } catch (e: any) {
      errMsg = String(e?.message ?? e).slice(0, 300);
      throw e;
    } finally {
      try {
        await query(
          `INSERT INTO agent_runs(user_id,kind,status,model,duration_ms,cost_usd,result,meta,error)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
          [
            userId,
            'voice_transcribe',
            ok ? 'ok' : 'error',
            model,
            Date.now() - started,
            0,
            text.slice(0, 8000) || null,
            JSON.stringify({ provider, local: true, audioSeconds: audioSeconds ?? null, bytes: buf.length, filename, mime }),
            ok ? null : errMsg,
          ]
        );
      } catch (e) { console.error('[voice] log failed', e); }
    }
    return { text, cost: 0, model, provider };
  }

  const started = Date.now();
  const fd = new FormData();
  const uint8 = new Uint8Array(buf);
  fd.append('file', new Blob([uint8], { type: mime }), filename);
  fd.append('model', model);
  if (cfg.language) fd.append('language', cfg.language);
  fd.append('response_format', 'json');

  let ok = false;
  let text = '';
  let errMsg: string | null = null;
  try {
    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });
    if (!res.ok) {
      errMsg = `${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
      throw new Error(`transcription ${errMsg}`);
    }
    const data: any = await res.json();
    text = (data?.text ?? '').trim();
    ok = true;
  } finally {
    const durationMs = Date.now() - started;
    const cost = audioSeconds != null ? estimateCost(model, audioSeconds) : null;
    try {
      await query(
        `INSERT INTO agent_runs(user_id,kind,status,model,duration_ms,cost_usd,result,meta,error)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        [
          userId,
          'voice_transcribe',
          ok ? 'ok' : 'error',
          model,
          durationMs,
          cost,
          text.slice(0, 8000) || null,
          JSON.stringify({ provider, baseUrl, audioSeconds: audioSeconds ?? null, bytes: buf.length, filename, mime }),
          ok ? null : errMsg,
        ]
      );
    } catch (e) { console.error('[voice] log failed', e); }
  }

  const finalCost = audioSeconds != null ? estimateCost(model, audioSeconds) : null;
  return { text, cost: finalCost, model, provider };
}

const connector: Connector = {
  manifest: {
    name: 'voice',
    title: 'Voice Transcription',
    description: 'Transcribe Telegram voice/audio messages via Whisper (local, OpenAI or Groq).',
    configSchema: [
      { key: 'provider', label: 'Provider (local | openai | groq | custom)', type: 'text', required: true, placeholder: 'local' },
      { key: 'apiKey', label: 'API key (non serve con provider local)', type: 'password' },
      { key: 'baseUrl', label: 'Base URL (optional override)', type: 'text', placeholder: 'https://api.openai.com/v1' },
      { key: 'model', label: 'Model (optional)', type: 'text', placeholder: 'small (local) / whisper-1 / whisper-large-v3' },
      { key: 'language', label: 'Force language (ISO-639-1)', type: 'text', placeholder: 'it' },
      { key: 'binPath', label: 'Percorso whisper (solo provider local)', type: 'text', placeholder: LOCAL_WHISPER_DEFAULT },
    ],
  },
  tools: [
    {
      name: 'status',
      description: 'Check voice transcription provider/model in use.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const cfg = await getVoiceConfig(ctx.userId);
        const provider = cfg.provider ?? 'openai';
        const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.openai;
        if (provider === 'local') {
          return {
            configured: true,
            provider,
            model: cfg.model || defaults.model,
            binPath: cfg.binPath || LOCAL_WHISPER_DEFAULT,
            language: cfg.language || 'auto',
            cost: 'nessuno, gira sulla macchina',
          };
        }
        if (!cfg.apiKey) return { configured: false };
        return { configured: true, provider, model: cfg.model || defaults.model, baseUrl: cfg.baseUrl || defaults.baseUrl, language: cfg.language || 'auto' };
      },
    },
  ],
};

export default connector;
