// Test end-to-end (sola lettura) del draft arricchito a 4 fonti.
// NON invia nulla, non scrive su DB/Telegram. Uso: npx tsx scripts/draft-test.ts [listId]
import { previewDraftForClient } from '../src/arm/client_messages.js';

const listId = process.argv[2];
const p = await previewDraftForClient(1, listId);

console.log('CLIENTE:', p.client.clickup_list_name, '| tipo:', p.client.client_type, '| canale esterno:', p.client.channel);
console.log('TASK:', p.tasks.map((t) => t.name).join(' | '));
console.log('PREVIEW LINK:', p.previewLink ?? '(nessuno)');
console.log('CONTESTO fonti →',
  `commenti task=${p.context.taskComments}, chat esterna=${p.context.externalChat}, chat interna=${p.context.internalChat}`);
console.log('\n===== MESSAGGIO GENERATO (bozza, NON inviato) =====\n');
console.log(p.body);
console.log('\n===== fine =====');
process.exit(0);
