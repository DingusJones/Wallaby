/* Wallaby API Proxy — Cloudflare Worker
   Hides API keys from the frontend. Free tier: 100k requests/day.
   
   Architecture:
   - EVM DeFi positions: Rabby/DeBank API (api.rabby.io) — FREE, no key needed
   - Solana positions: Mobula API (demo-api.mobula.io or api.mobula.io) — free demo or free key
   - Token balances: Rabby token_list + Mobula portfolio
   
   The Rabby API is keyless and could be called directly from the browser,
   but we proxy it here for CORS reliability and to add caching/normalization.
   
   Setup (optional — only needed for Mobula production):
   1. Get free Mobula API key at https://admin.mobula.io
   2. wrangler secret put MOBULA_API_KEY
   3. wrangler deploy
   4. Set the worker URL in app.js CONFIG.proxyUrl
*/

const RABBY_BASE = 'https://api.rabby.io';
const MOBULA_DEMO_BASE = 'https://demo-api.mobula.io/api';
const MOBULA_PROD_BASE = 'https://api.mobula.io/api';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const params = url.searchParams;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (path === '/positions') {
        return await handlePositions(params, env, corsHeaders);
      } else if (path === '/balances') {
        return await handleBalances(params, env, corsHeaders);
      } else if (path === '/networth') {
        return await handleNetWorth(params, env, corsHeaders);
      } else if (path === '/health') {
        return jsonResponse({ status: 'ok', sources: ['rabby', 'mobula'] }, corsHeaders);
      } else {
        return jsonResponse({ error: 'Not found' }, corsHeaders, 404);
      }
    } catch (err) {
      return jsonResponse({ error: err.message }, corsHeaders, 500);
    }
  }
};

// ── Chain detection ──
function detectChain(address) {
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return 'solana';
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return 'evm';
  return null;
}

// ── Positions endpoint ──
async function handlePositions(params, env, corsHeaders) {
  const address = params.get('address');
  if (!address) {
    return jsonResponse({ error: 'Missing address' }, corsHeaders, 400);
  }

  const chain = detectChain(address);
  const positions = [];

  if (chain === 'evm') {
    // ── EVM: Use Rabby API (free, no key) ──
    try {
      const rabbyPositions = await fetchRabbyPositions(address);
      positions.push(...rabbyPositions);
    } catch (err) {
      console.log('Rabby fetch failed:', err.message);
    }
  }

  if (chain === 'solana') {
    // ── Solana: Use Mobula API ──
    try {
      const mobulaPositions = await fetchMobulaPositions(address, env);
      positions.push(...mobulaPositions);
    } catch (err) {
      console.log('Mobula fetch failed:', err.message);
    }
  }

  // If auto-detect failed but address looks like EVM, try Rabby anyway
  if (chain === 'evm' && positions.length === 0) {
    // Already tried Rabby above, nothing more to do
  }

  return jsonResponse({ positions, chain }, corsHeaders);
}

// ── Net worth endpoint ──
async function handleNetWorth(params, env, corsHeaders) {
  const address = params.get('address');
  if (!address) {
    return jsonResponse({ error: 'Missing address' }, corsHeaders, 400);
  }

  const chain = detectChain(address);

  if (chain === 'evm') {
    // Rabby total balance
    try {
      const res = await fetch(`${RABBY_BASE}/v1/user/total_balance?id=${encodeURIComponent(address)}`);
      if (res.ok) {
        const data = await res.json();
        const chainBreakdown = {};
        (data.chain_list || []).forEach(c => {
          if (c.usd_value > 0) {
            chainBreakdown[mapRabbyChainId(c.id)] = c.usd_value;
          }
        });
        return jsonResponse({
          totalUsd: data.total_usd_value || 0,
          chainBreakdown,
          source: 'rabby',
        }, corsHeaders);
      }
    } catch (err) {
      // fall through
    }
    return jsonResponse({ totalUsd: 0, chainBreakdown: {}, source: 'rabby' }, corsHeaders);
  }

  if (chain === 'solana') {
    // Mobula portfolio for net worth
    try {
      const mobulaKey = env.MOBULA_API_KEY;
      const base = mobulaKey ? MOBULA_PROD_BASE : MOBULA_DEMO_BASE;
      const headers = mobulaKey ? { 'Authorization': `Bearer ${mobulaKey}` } : {};
      const url = `${base}/1/wallet/portfolio?wallet=${encodeURIComponent(address)}&blockchains=solana`;
      const res = await fetch(url, { headers });
      if (res.ok) {
        const data = await res.json();
        const totalUsd = data.total_wallet_balance || 0;
        return jsonResponse({
          totalUsd,
          chainBreakdown: { solana: totalUsd },
          source: 'mobula',
        }, corsHeaders);
      }
    } catch (err) {
      // fall through
    }
    return jsonResponse({ totalUsd: 0, chainBreakdown: {}, source: 'mobula' }, corsHeaders);
  }

  return jsonResponse({ totalUsd: 0, chainBreakdown: {}, source: 'none' }, corsHeaders);
}

// ── Balances endpoint ──
async function handleBalances(params, env, corsHeaders) {
  const address = params.get('address');
  if (!address) {
    return jsonResponse({ error: 'Missing address' }, corsHeaders, 400);
  }

  const chain = detectChain(address);
  const balances = [];

  if (chain === 'evm') {
    // Rabby token list
    try {
      const res = await fetch(`${RABBY_BASE}/v1/user/token_list?id=${encodeURIComponent(address)}`);
      if (res.ok) {
        const data = await res.json();
        (data || []).forEach(token => {
          balances.push({
            chain: mapRabbyChainId(token.chain),
            token: token.symbol || token.name || '',
            amount: parseFloat(token.amount || 0),
            valueUsd: parseFloat(token.usd_value || 0),
            price: parseFloat(token.price || 0),
          });
        });
      }
    } catch (err) {
      console.log('Rabby token_list failed:', err.message);
    }
  }

  if (chain === 'solana') {
    // Mobula portfolio for token balances
    try {
      const mobulaKey = env.MOBULA_API_KEY;
      const base = mobulaKey ? MOBULA_PROD_BASE : MOBULA_DEMO_BASE;
      const headers = mobulaKey ? { 'Authorization': `Bearer ${mobulaKey}` } : {};
      const url = `${base}/1/wallet/portfolio?wallet=${encodeURIComponent(address)}&blockchains=solana`;
      const res = await fetch(url, { headers });
      if (res.ok) {
        const data = await res.json();
        (data.assets || []).forEach(asset => {
          balances.push({
            chain: 'solana',
            token: asset.token?.symbol || asset.token?.name || '',
            amount: parseFloat(asset.token_balance || 0),
            valueUsd: parseFloat(asset.estimated_balance || 0),
            price: parseFloat(asset.token?.price || 0),
          });
        });
      }
    } catch (err) {
      console.log('Mobula portfolio failed:', err.message);
    }
  }

  return jsonResponse({ balances }, corsHeaders);
}

// ═══════════════════════════════════════════
// RABBY API — EVM DeFi positions (free, no key)
// ═══════════════════════════════════════════
async function fetchRabbyPositions(address) {
  // Use complex_protocol_list for full DeFi position detail
  const url = `${RABBY_BASE}/v1/user/complex_protocol_list?id=${encodeURIComponent(address)}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Rabby API error: ${res.status}`);
  }

  const data = await res.json();
  const positions = [];

  (data || []).forEach(protocol => {
    const chain = mapRabbyChainId(protocol.chain);
    const protocolName = protocol.name || 'Unknown';
    const protocolLogo = protocol.logo_url || null;
    const siteUrl = protocol.site_url || null;
    const tvl = protocol.tvl || 0;

    (protocol.portfolio_item_list || []).forEach(item => {
      const stats = item.stats || {};
      const detail = item.detail || {};
      const detailTypes = item.detail_types || [];

      // Determine position type
      let posType = item.name || 'Position';
      if (detailTypes.includes('lending')) posType = 'Lending';
      else if (detailTypes.includes('yield')) posType = 'Yield';
      else if (detailTypes.includes('staking')) posType = 'Staking';
      else if (detailTypes.length > 0) posType = detailTypes[0].charAt(0).toUpperCase() + detailTypes[0].slice(1);

      // Extract supply tokens for display
      const supplyTokens = (detail.supply_token_list || []).map(t => ({
        symbol: t.symbol,
        amount: parseFloat(t.amount || 0),
        price: parseFloat(t.price || 0),
      }));
      const rewardTokens = (detail.reward_token_list || []).map(t => ({
        symbol: t.symbol,
        amount: parseFloat(t.amount || 0),
        price: parseFloat(t.price || 0),
      }));
      const debtTokens = (detail.debt_token_list || []).map(t => ({
        symbol: t.symbol,
        amount: parseFloat(t.amount || 0),
        price: parseFloat(t.price || 0),
      }));

      positions.push({
        chain,
        protocol: protocolName,
        protocolLogo,
        siteUrl,
        tvl,
        type: posType,
        valueUsd: parseFloat(stats.net_usd_value || 0),
        assetUsd: parseFloat(stats.asset_usd_value || 0),
        debtUsd: parseFloat(stats.debt_usd_value || 0),
        supplyTokens,
        rewardTokens,
        debtTokens,
        healthRate: detail.health_rate != null ? parseFloat(detail.health_rate) : null,
        pool: item.pool || null,
        url: siteUrl,
      });
    });
  });

  return positions;
}

// ═══════════════════════════════════════════
// MOBULA API — Solana positions (free demo or free key)
// ═══════════════════════════════════════════
async function fetchMobulaPositions(address, env) {
  const mobulaKey = env.MOBULA_API_KEY;
  const base = mobulaKey ? MOBULA_PROD_BASE : MOBULA_DEMO_BASE;
  const headers = mobulaKey ? { 'Authorization': `Bearer ${mobulaKey}` } : {};

  // Fetch positions with PnL
  const url = `${base}/2/wallet/positions?wallet=${encodeURIComponent(address)}&blockchains=solana:solana`;
  const res = await fetch(url, { headers });

  if (!res.ok) {
    throw new Error(`Mobula API error: ${res.status}`);
  }

  const data = await res.json();
  const positions = [];

  (data.data || []).forEach(pos => {
    const token = pos.token || {};
    positions.push({
      chain: 'solana',
      protocol: token.name || 'Solana Token',
      protocolLogo: token.logo || null,
      siteUrl: null,
      tvl: 0,
      type: 'Holdings',
      valueUsd: parseFloat(pos.amountUSD || 0),
      amount: parseFloat(pos.balance || 0),
      token: token.symbol || '',
      price: parseFloat(token.priceUSD || 0),
      realizedPnl: parseFloat(pos.realizedPnlUSD || 0),
      unrealizedPnl: parseFloat(pos.unrealizedPnlUSD || 0),
      url: null,
    });
  });

  return positions;
}

// ═══════════════════════════════════════════
// CHAIN MAPPING
// ═══════════════════════════════════════════
function mapRabbyChainId(id) {
  const map = {
    'eth': 'ethereum',
    'bsc': 'bsc',
    'arb': 'arbitrum',
    'op': 'optimism',
    'base': 'base',
    'matic': 'polygon',
    'avax': 'avalanche',
    'ftm': 'fantom',
    'linea': 'linea',
    'scroll': 'scroll',
    'blast': 'blast',
    'zora': 'zora',
    'manta': 'manta',
    'era': 'zksync',
    'moonbeam': 'moonbeam',
    'celo': 'celo',
    'gnosis': 'gnosis',
    'core': 'core',
    'xdc': 'xdc',
    'stable': 'stable',
  };
  return map[id] || (typeof id === 'string' ? id : 'unknown');
}

function jsonResponse(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}