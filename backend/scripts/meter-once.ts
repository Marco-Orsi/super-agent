// One-off: esegue a mano il readout mattutino del meter (identico al cron 09:05).
import { listActiveUsers } from '../src/db/index.js';
import { updateAutoCloseKpi } from '../src/supervisor/meter.js';
import { sendTelegram } from '../src/telegram/bot.js';

const users = await listActiveUsers();
console.log(`[meter-once] utenti attivi: ${users.length}`);
for (const u of users) {
  const r = await updateAutoCloseKpi(u.id);
  const goalNote = r.goalId ? '' : ' (nessun goal attivo — solo backup)';
  const msg = `📊 Meter task auto-chiuse (7gg): ${r.rate}% — ${r.auto}/${r.closed} chiuse dall'agente · target 70%${goalNote}`;
  console.log(`[meter-once:u${u.id}] ${msg}`);
  const sent = await sendTelegram(u.id, msg, 'meter').then(() => 'ok').catch((e) => `FAIL ${e?.message ?? e}`);
  console.log(`[meter-once:u${u.id}] telegram: ${sent}`);
}
process.exit(0);
