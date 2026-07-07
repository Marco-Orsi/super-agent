import type { Connector } from '../../types.js';

const API_VERSION = '2025-01';

async function shopifyFetch(shop: string, token: string, body: { query: string; variables?: Record<string, any> }) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json() as any;
  if (json.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join('; '));
  return json.data;
}

function getActive(config: Record<string, any>): { shop: string; token: string } {
  const active = config.active_store as string | undefined;
  const stores = (config.stores ?? {}) as Record<string, string>;
  if (active && stores[active]) return { shop: active, token: stores[active] };
  // Fallback: top-level fields (backward compat)
  if (config.shop && config.access_token) return { shop: config.shop, token: config.access_token };
  throw new Error('Nessuno store Shopify configurato. Usa shopify_add_store per aggiungerne uno.');
}

const connector: Connector = {
  manifest: {
    name: 'shopify',
    title: 'Shopify Admin',
    description: 'Accesso diretto all\'Admin API Shopify con token permanente. Multi-store.',
    configSchema: [
      { key: 'shop', label: 'Dominio myshopify (es. vimavimaterassi.myshopify.com)', type: 'text', required: false },
      { key: 'access_token', label: 'Admin API Access Token (shpat_...)', type: 'password', required: false },
    ],
  },

  onConfigSaved: async (ctx) => {
    if (ctx.config.shop && ctx.config.access_token) {
      const stores = (ctx.state.stores ?? {}) as Record<string, string>;
      stores[ctx.config.shop] = ctx.config.access_token;
      await ctx.saveState({ ...ctx.state, stores, active_store: ctx.config.shop });
      ctx.log(`store configurato: ${ctx.config.shop}`);
    }
  },

  tools: [
    {
      name: 'add_store',
      description: 'Aggiunge (o aggiorna) uno store Shopify con il suo access token. Lo imposta come attivo.',
      inputSchema: {
        type: 'object',
        properties: {
          shop: { type: 'string', description: 'Dominio myshopify.com (es. vimavimaterassi.myshopify.com)' },
          access_token: { type: 'string', description: 'Admin API token (shpat_...)' },
        },
        required: ['shop', 'access_token'],
        additionalProperties: false,
      },
      handler: async (ctx, { shop, access_token }) => {
        const stores = { ...(ctx.state.stores ?? {}) as Record<string, string>, [shop]: access_token };
        await ctx.saveState({ ...ctx.state, stores, active_store: shop });
        return { ok: true, active: shop, total_stores: Object.keys(stores).length };
      },
    },
    {
      name: 'switch_store',
      description: 'Cambia lo store attivo (deve essere già stato aggiunto con add_store).',
      inputSchema: {
        type: 'object',
        properties: {
          shop: { type: 'string', description: 'Dominio myshopify.com da attivare' },
        },
        required: ['shop'],
        additionalProperties: false,
      },
      handler: async (ctx, { shop }) => {
        const stores = (ctx.state.stores ?? {}) as Record<string, string>;
        if (!stores[shop]) throw new Error(`Store "${shop}" non trovato. Aggiungilo prima con shopify_add_store.`);
        await ctx.saveState({ ...ctx.state, active_store: shop });
        return { ok: true, active: shop };
      },
    },
    {
      name: 'list_stores',
      description: 'Elenca gli store Shopify configurati e quale è attivo.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const stores = (ctx.state.stores ?? {}) as Record<string, string>;
        const active = ctx.state.active_store as string | undefined;
        return {
          active,
          stores: Object.keys(stores).map((s) => ({ shop: s, is_active: s === active })),
        };
      },
    },
    {
      name: 'get_shop',
      description: 'Restituisce info base sullo store attivo (nome, piano, valuta, dominio).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const { shop, token } = getActive({ ...ctx.config, ...ctx.state });
        const data = await shopifyFetch(shop, token, {
          query: `{ shop { name email myshopifyDomain plan { displayName } currencyCode timezoneAbbreviation } }`,
        });
        return data.shop;
      },
    },
    {
      name: 'graphql',
      description: 'Esegue una query o mutation GraphQL sull\'Admin API dello store attivo.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Query o mutation GraphQL' },
          variables: { type: 'object', description: 'Variabili GraphQL (opzionale)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      handler: async (ctx, { query, variables }) => {
        const { shop, token } = getActive({ ...ctx.config, ...ctx.state });
        return shopifyFetch(shop, token, { query, variables });
      },
    },
    {
      name: 'upload_from_url',
      description: 'Carica un file (immagine) su Shopify partendo da un URL esterno. Ritorna l\'URL CDN Shopify del file caricato.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL pubblico del file da caricare' },
          alt: { type: 'string', description: 'Testo alternativo del file' },
          filename: { type: 'string', description: 'Nome file (opzionale)' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      handler: async (ctx, { url, alt = '', filename }) => {
        const { shop, token } = getActive({ ...ctx.config, ...ctx.state });

        const mutation = `
          mutation fileCreate($files: [FileCreateInput!]!) {
            fileCreate(files: $files) {
              files {
                id
                alt
                createdAt
                ... on MediaImage {
                  image { url width height }
                }
              }
              userErrors { field message }
            }
          }
        `;

        const data = await shopifyFetch(shop, token, {
          query: mutation,
          variables: {
            files: [{
              alt,
              contentType: 'IMAGE',
              originalSource: url,
              ...(filename ? { filename } : {}),
            }],
          },
        });

        const errors = data.fileCreate?.userErrors;
        if (errors?.length) throw new Error(errors.map((e: any) => e.message).join('; '));

        const file = data.fileCreate?.files?.[0];
        return {
          ok: true,
          id: file?.id,
          shopify_url: file?.image?.url ?? null,
          alt: file?.alt,
          note: 'Il file è ora disponibile in Shopify Admin → Contenuto → File',
        };
      },
    },
  ],
};

export default connector;
