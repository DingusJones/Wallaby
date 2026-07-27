/* Wallaby — Cross-chain wallet position viewer
   Main app logic: wallet management, direct API calls, position rendering.
   
   Data sources (both CORS-enabled, called directly from browser — no proxy needed):
   - EVM: Rabby/DeBank API (api.rabby.io) — free, no key, 60+ chains, full DeFi positions
   - Solana: Mobula demo API (demo-api.mobula.io) — free, token holdings + PnL
     (PLACEHOLDER — upgrade when a better free Solana DeFi API surfaces)
*/

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const RABBY_API = 'https://api.rabby.io';
const MOBULA_API = 'https://demo-api.mobula.io/api';

// Cache TTL in ms (2 minutes)
const CACHE_TTL = 2 * 60 * 1000;
// Max retries on 429
const MAX_RETRIES = 3;
// Base delay between retries (exponential backoff)
const RETRY_BASE_DELAY = 2000;

const CHAIN_META = {
  ethereum:  { name: 'Ethereum',  icon: '🔷', color: '#627eea', explorer: 'https://etherscan.io/address/' },
  base:      { name: 'Base',      icon: '🔵', color: '#0052ff', explorer: 'https://basescan.org/address/' },
  arbitrum:  { name: 'Arbitrum',  icon: '🟦', color: '#28a0f0', explorer: 'https://arbiscan.io/address/' },
  optimism:  { name: 'Optimism',  icon: '🔴', color: '#ff0420', explorer: 'https://optimistic.etherscan.io/address/' },
  polygon:   { name: 'Polygon',   icon: '🟣', color: '#8247e5', explorer: 'https://polygonscan.com/address/' },
  bsc:       { name: 'BNB Chain', icon: '🟡', color: '#f0b90b', explorer: 'https://bscscan.com/address/' },
  avalanche: { name: 'Avalanche', icon: '🔺', color: '#e84142', explorer: 'https://snowtrace.io/address/' },
  fantom:    { name: 'Fantom',    icon: '👻', color: '#1969ff', explorer: 'https://ftmscan.com/address/' },
  linea:     { name: 'Linea',     icon: '⚫', color: '#61dfff', explorer: 'https://lineascan.build/address/' },
  scroll:    { name: 'Scroll',    icon: '📜', color: '#f0f0f0', explorer: 'https://scrollscan.com/address/' },
  blast:     { name: 'Blast',     icon: '🟡', color: '#ffcf00', explorer: 'https://blastscan.io/address/' },
  zksync:    { name: 'zkSync',    icon: '⚪', color: '#1e69ff', explorer: 'https://explorer.zksync.io/address/' },
  zora:      { name: 'Zora',      icon: '⚪', color: '#444',    explorer: 'https://explorer.zora.energy/address/' },
  manta:     { name: 'Manta',    icon: '🔵', color: '#00b8ff', explorer: 'https://pacific-explorer.manta.network/address/' },
  moonbeam:  { name: 'Moonbeam',  icon: '🌙', color: '#ff4757', explorer: 'https://moonbeam.moonscan.io/address/' },
  celo:      { name: 'Celo',     icon: '🟡', color: '#fbcc5c', explorer: 'https://celoscan.io/address/' },
  gnosis:    { name: 'Gnosis',   icon: '🟢', color: '#3e6957', explorer: 'https://gnosisscan.io/address/' },
  solana:    { name: 'Solana',   icon: '🟣', color: '#9945ff', explorer: 'https://solscan.io/account/' },
};

// Rabby chain ID → explorer URL for pool contract links
const RABBY_CHAIN_EXPLORER = {
  eth: 'https://etherscan.io/address/',
  base: 'https://basescan.org/address/',
  arb: 'https://arbiscan.io/address/',
  op: 'https://optimistic.etherscan.io/address/',
  matic: 'https://polygonscan.com/address/',
  bsc: 'https://bscscan.com/address/',
  avax: 'https://snowtrace.io/address/',
  ftm: 'https://ftmscan.com/address/',
  linea: 'https://lineascan.build/address/',
  scroll: 'https://scrollscan.com/address/',
  blast: 'https://blastscan.io/address/',
  era: 'https://explorer.zksync.io/address/',
  zora: 'https://explorer.zora.energy/address/',
  manta: 'https://pacific-explorer.manta.network/address/',
  moonbeam: 'https://moonbeam.moonscan.io/address/',
  celo: 'https://celoscan.io/address/',
  gnosis: 'https://gnosisscan.io/address/',
};

// Rabby chain ID → our chain key
const RABBY_CHAIN_MAP = {
  eth: 'ethereum', bsc: 'bsc', arb: 'arbitrum', op: 'optimism',
  base: 'base', matic: 'polygon', avax: 'avalanche', ftm: 'fantom',
  linea: 'linea', scroll: 'scroll', blast: 'blast', era: 'zksync',
  zora: 'zora', manta: 'manta', moonbeam: 'moonbeam', celo: 'celo',
  gnosis: 'gnosis', core: 'core', xdai: 'gnosis',
};

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
const state = {
  wallets: [],
  activeWalletIdx: 0,
  activeChainFilter: 'all',
};

const STORAGE_KEY = 'wallaby_wallets';

// ═══════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════
function loadWallets() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) state.wallets = JSON.parse(saved);
  } catch (e) { state.wallets = []; }
}

function saveWallets() {
  const toSave = state.wallets.map(w => ({
    address: w.address, chain: w.chain, label: w.label || '',
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
}

// ═══════════════════════════════════════════
// CHAIN DETECTION
// ═══════════════════════════════════════════
function detectChain(address) {
  const addr = address.trim();
  // Solana: base58, 32-44 chars, doesn't start with 0x
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return 'solana';
  // EVM: 0x + 40 hex chars
  if (/^0x[a-fA-F0-9]{40}$/.test(addr)) return 'evm';
  return null;
}

function shortenAddress(address) {
  if (address.length <= 12) return address;
  if (address.startsWith('0x')) return address.slice(0, 6) + '...' + address.slice(-4);
  return address.slice(0, 4) + '...' + address.slice(-4);
}

// ═══════════════════════════════════════════
// DEEP LINK BUILDER — links to actual vault/position UIs
// ═══════════════════════════════════════════
// Maps Rabby protocol IDs to the protocol's actual UI where you can deposit/withdraw.
// Falls back to site_url, then block explorer.
function buildPositionUrl(protocolId, adapterId, rabbyChain, poolAddr, siteUrl, supplyTokens) {
  const pid = protocolId.toLowerCase();

  // Protocol-specific URL builders — link to the actual vault/position page
  const links = {
    // Aave V2/V3 — link to reserve page on Aave UI
    'aave2': () => `https://app.aave.com/?market_name=proto_mainnet`,
    'aave3': () => `https://app.aave.com/?market_name=proto_mainnet_v3`,
    'aave_v3': () => `https://app.aave.com/?market_name=proto_mainnet_v3`,

    // Uniswap — link to the pool on Uniswap UI
    'uniswap2': () => `https://app.uniswap.org/#/pool`,
    'uniswap3': () => `https://app.uniswap.org/#/pool`,
    'uniswap4': () => `https://app.uniswap.org/#/pool`,
    'base_uniswap2': () => `https://app.uniswap.org/#/pool`,
    'base_uniswap3': () => `https://app.uniswap.org/#/pool`,

    // Curve — link to the pool page
    'curve': () => poolAddr ? `https://curve.fi/#/ethereum/pools` : siteUrl,

    // Yearn — link to the vault page
    'yearn': () => poolAddr ? `https://yearn.fi/vaults/1/${poolAddr}` : `https://yearn.fi/vaults`,
    'base_yearn3': () => poolAddr ? `https://yearn.fi/vaults/8453/${poolAddr}` : `https://yearn.fi/vaults`,
    'yearn3': () => poolAddr ? `https://yearn.fi/vaults/1/${poolAddr}` : `https://yearn.fi/vaults`,

    // Lido — link to staking page
    'lido': () => `https://lido.fi/`,
    'etherfi': () => `https://app.ether.fi/`,

    // Balancer — link to pool page
    'balancer': () => poolAddr ? `https://balancer.fi/pools/ethereum/v2/${poolAddr}` : `https://balancer.fi/pools`,

    // Maker/Spark
    'makerdao': () => `https://app.spark.fi/`,
    'spark': () => `https://app.spark.fi/`,

    // Sky
    'sky': () => `https://app.sky.money/`,

    // PancakeSwap
    'bsc_pancakeswap': () => `https://pancakeswap.finance/pools`,

    // SushiSwap
    'base_sushiswap3': () => `https://www.sushi.com/pools`,
    'sushi': () => `https://www.sushi.com/pools`,

    // QuickSwap
    'matic_quickswap': () => `https://quickswap.exchange/pools`,

    // Convex
    'convex': () => `https://www.convexfinance.com/`,

    // Compound
    'compound': () => `https://app.compound.finance/`,
    'compound3': () => `https://app.compound.finance/`,

    // 1inch
    '1inch2': () => `https://app.1inch.io/`,

    // TokenSets
    'tokensets': () => poolAddr ? `https://tokensets.com/set/${poolAddr}` : `https://tokensets.com`,

    // Pangolin
    'avax_pangolin': () => `https://app.pangolin.exchange/pools`,

    // LFJ (TraderJoe)
    'avax_traderjoexyz': () => `https://lfj.gg/pools`,

    // Euler
    'avax_euler2': () => `https://app.euler.finance/vaults`,

    // Shell
    'shell': () => `https://www.shellprotocol.io/pools`,

    // Element
    'element': () => `https://app.element.fi/fixedrates/`,

    // Ambire
    'ambire': () => `https://wallet.ambire.com/`,

    // Sablier
    'sablier': () => `https://app.sablier.com/`,
    'matic_sablier': () => `https://app.sablier.com/`,

    // Superfluid
    'matic_superfluid': () => `https://app.superfluid.org/`,
    'op_superfluid': () => `https://app.superfluid.org/`,
    'arb_superfluid': () => `https://app.superfluid.org/`,

    // Terminal
    'terminal': () => `https://terminal.fi/`,

    // Hedgey
    'linea_hedgey': () => `https://app.hedgey.finance/`,

    // Firebot
    'matic_firebot': () => `https://firebot.gg/`,

    // ZetaHub
    'zeta_zetahub': () => `https://hub.zetachain.com/`,

    // iZUMi
    'manta_izumi': () => `https://izumi.finance/pools`,

    // DYORSWAP
    'blast_dyorswap': () => `https://dyorswap.finance/pools`,

    // ShibaSwap
    'shibaswap': () => `https://shibaswap.com/pools`,

    // Nitro Cartel
    'arb_nitrocartel': () => `https://nitrocartel.finance/`,

    // clanker
    'base_clanker': () => `https://www.clanker.world`,

    // ZORA
    'base_zoraco': () => `https://zora.co/`,

    // Morpho — V2+ vaults only, link to actual vault page with vault name slug
    // Rabby pool.id = vault contract address; we also try pool.name for the URL slug
    'morpho': () => {
      const mc = { eth: 'ethereum', base: 'base', arb: 'arbitrum', op: 'optimism', matic: 'polygon' }[rabbyChain] || rabbyChain;
      return poolAddr ? `https://app.morpho.org/${mc}/vault/${poolAddr}` : `https://app.morpho.org/`;
    },
    'morphoblue': () => {
      const mc = { eth: 'ethereum', base: 'base', arb: 'arbitrum', op: 'optimism', matic: 'polygon' }[rabbyChain] || rabbyChain;
      return poolAddr ? `https://app.morpho.org/${mc}/vault/${poolAddr}` : `https://app.morpho.org/`;
    },
    'morpho_vault': () => {
      const mc = { eth: 'ethereum', base: 'base', arb: 'arbitrum', op: 'optimism', matic: 'polygon' }[rabbyChain] || rabbyChain;
      return poolAddr ? `https://app.morpho.org/${mc}/vault/${poolAddr}` : `https://app.morpho.org/`;
    },
    'base_morpho': () => {
      const mc = { eth: 'ethereum', base: 'base', arb: 'arbitrum', op: 'optimism', matic: 'polygon' }[rabbyChain] || rabbyChain;
      return poolAddr ? `https://app.morpho.org/${mc}/vault/${poolAddr}` : `https://app.morpho.org/`;
    },

    // Pendle — specific market link, works without wallet connect
    // URL pattern: app.pendle.finance/trade/markets/{marketAddr}/swap?view=pt&chain={chain}
    'pendle': () => {
      const pc = { eth: 'ethereum', base: 'base', arb: 'arbitrum', op: 'optimism', matic: 'polygon' }[rabbyChain] || rabbyChain;
      return poolAddr ? `https://app.pendle.finance/trade/markets/${poolAddr}/swap?view=pt&chain=${pc}` : `https://app.pendle.finance/`;
    },
    'base_pendle': () => {
      const pc = { base: 'base' }[rabbyChain] || rabbyChain;
      return poolAddr ? `https://app.pendle.finance/trade/markets/${poolAddr}/swap?view=pt&chain=${pc}` : `https://app.pendle.finance/`;
    },
    'arb_pendle': () => {
      const pc = { arb: 'arbitrum' }[rabbyChain] || rabbyChain;
      return poolAddr ? `https://app.pendle.finance/trade/markets/${poolAddr}/swap?view=pt&chain=${pc}` : `https://app.pendle.finance/`;
    },

    // Moonwell — link to specific market page for lending, vaults page for vaults
    'moonwell': () => `https://app.moonwell.fi/`,
    'base_moonwell': () => `https://app.moonwell.fi/`,
    'moonwell_vault': () => `https://app.moonwell.fi/vaults`,
    'base_moonwell_vault': () => `https://app.moonwell.fi/vaults`,

    // Fluid — lending protocol
    'fluid': () => `https://app.fluid.io/`,
    'base_fluid': () => `https://app.fluid.io/`,

    // Seamless — lending on Base
    'base_seamless': () => `https://app.seamlessprotocol.com/`,

    // Spark on Base
    'base_spark': () => `https://app.spark.fi/`,

    // Aerodrome — DEX on Base
    'base_aerodrome': () => poolAddr ? `https://aerodrome.finance/pools` : `https://aerodrome.finance/`,
  };

  // Try protocol-specific link
  if (links[pid]) {
    return links[pid]();
  }

  // Try with adapter_id as fallback (e.g., uniswap2_liquidity_proxy → Uniswap)
  if (adapterId) {
    const aid = adapterId.toLowerCase();
    if (aid.includes('uniswap2') || aid.includes('uniswap3') || aid.includes('uniswap4')) return `https://app.uniswap.org/#/pool`;
    if (aid.includes('aave')) return `https://app.aave.com/`;
    if (aid.includes('curve')) return `https://curve.fi/#/ethereum/pools`;
    if (aid.includes('yearn')) return `https://yearn.fi/vaults`;
    if (aid.includes('pancakeswap')) return `https://pancakeswap.finance/pools`;
    if (aid.includes('pendle')) {
      const pc = { eth: 'ethereum', base: 'base', arb: 'arbitrum', op: 'optimism', matic: 'polygon' }[rabbyChain] || rabbyChain;
      return poolAddr ? `https://app.pendle.finance/trade/markets/${poolAddr}/swap?view=pt&chain=${pc}` : `https://app.pendle.finance/`;
    }
    if (aid.includes('moonwell')) return `https://app.moonwell.fi/`;
    if (aid.includes('morpho')) {
      const mc = { eth: 'ethereum', base: 'base', arb: 'arbitrum', op: 'optimism', matic: 'polygon' }[rabbyChain] || rabbyChain;
      return poolAddr ? `https://app.morpho.org/${mc}/vault/${poolAddr}` : `https://app.morpho.org/`;
    }
    if (aid.includes('lending')) return siteUrl || null;
  }

  // Fall back to protocol site_url
  return siteUrl || null;
}

// ═══════════════════════════════════════════
// DEFILLAMA PROTOCOL TVL + CATEGORIES
// ═══════════════════════════════════════════
// Fetch DeFiLlama /protocols once → map of name → {tvl, slug, category}
// Used for accurate TVL (replaces Rabby's often-wrong tvl field) and proper category labels.
let llamaProtocolsCache = null;

async function fetchLlamaProtocols() {
  if (llamaProtocolsCache) return llamaProtocolsCache;
  try {
    const data = await cachedFetch('https://api.llama.fi/protocols', { cacheKey: 'llama_protocols' });
    const lookup = {};
    (data || []).forEach(p => {
      const name = (p.name || '').toLowerCase();
      if (!name) return;
      lookup[name] = {
        tvl: parseFloat(p.tvl || 0),
        slug: p.slug || '',
        category: p.category || '',
        url: p.url || '',
      };
    });
    llamaProtocolsCache = lookup;
    return lookup;
  } catch (e) {
    return {};
  }
}

// Match a Rabby protocol name to DeFiLlama protocol data
function matchLlamaProtocol(protocols, protocolName) {
  if (!protocols || !protocolName) return null;
  const pn = protocolName.toLowerCase();
  // Exact match
  if (protocols[pn]) return protocols[pn];
  // Try without version suffixes (e.g., "aave v3" → "aave v3" already matches, but try "aave")
  const base = pn.replace(/\s+v\d+.*$/, '');
  if (protocols[base]) return protocols[base];
  // Try with common variations
  const variants = [
    pn.replace(' ', '-'),
    pn.replace(/\s+/g, '-'),
    pn.replace('morpho blue', 'morpho-blue'),
    pn.replace('moonwell lending', 'moonwell-lending'),
    pn.replace('moonwell vaults', 'moonwell-vaults'),
    pn.replace('compound v3', 'compound-v3'),
    pn.replace('compound v2', 'compound-v2'),
    pn.replace('aave v3', 'aave-v3'),
    pn.replace('aave v2', 'aave-v2'),
    pn.replace('uniswap v3', 'uniswap-v3'),
    pn.replace('uniswap v2', 'uniswap-v2'),
  ];
  for (const v of variants) {
    if (protocols[v]) return protocols[v];
  }
  // Partial match — find protocol whose name contains ours or vice versa
  for (const key of Object.keys(protocols)) {
    if (key.includes(pn) || pn.includes(key)) return protocols[key];
  }
  return null;
}

// Map DeFiLlama category → our display label
function categoryToLabel(category) {
  if (!category) return null;
  const cat = category.toLowerCase();
  if (cat.includes('lending')) return 'Lending';
  if (cat.includes('liquid staking')) return 'Liquid Staking';
  if (cat.includes('staking')) return 'Staking';
  if (cat.includes('dex') || cat.includes('amm')) return 'LP';
  if (cat.includes('yield')) return 'Yield';
  if (cat.includes('cdp')) return 'CDP';
  if (cat.includes('capital allocator')) return 'Yield Vault';
  if (cat.includes('rwa')) return 'RWA';
  if (cat.includes('bridge')) return 'Bridge';
  if (cat.includes('restaking')) return 'Restaking';
  if (cat.includes('money market')) return 'Money Market';
  return null; // don't override with unknown categories
}

// ═══════════════════════════════════════════
// DEFILLAMA YIELD ENRICHMENT (APY data)
// ═══════════════════════════════════════════
// Fetch DeFiLlama yields once, match positions to get APY data.
// Matches by protocol name + supply token symbol.
let llamaYieldsCache = null;

async function fetchLlamaYields() {
  if (llamaYieldsCache) return llamaYieldsCache;
  try {
    const data = await cachedFetch('https://yields.llama.fi/pools', { cacheKey: 'llama_yields' });
    const pools = data.data || [];
    // Build a lookup: { 'project_name': [ { symbol, apy, chain } ] }
    const lookup = {};
    pools.forEach(p => {
      const key = p.project.toLowerCase();
      if (!lookup[key]) lookup[key] = [];
      lookup[key].push({
        symbol: (p.symbol || '').toUpperCase(),
        apy: p.apy || 0,
        chain: (p.chain || '').toLowerCase(),
        tvlUsd: p.tvlUsd || 0,
      });
    });
    llamaYieldsCache = lookup;
    return lookup;
  } catch (e) {
    return {};
  }
}

// Match a Rabby position to a DeFiLlama pool to get APY
function matchApy(yields, protocolName, rabbyChain, supplyTokens) {
  if (!yields || !protocolName) return null;

  // Map Rabby protocol names to DeFiLlama project names
  const nameMap = {
    'aave v2': 'aave-v2',
    'aave v3': 'aave-v3',
    'uniswap v2': 'uniswap-v2',
    'uniswap v3': 'uniswap-v3',
    'sushiswap v3': 'sushiswap',
    'pancakeswap': 'pancakeswap',
    'quickswap': 'quickswap',
    'curve': 'curve-dex',
    'yearn v3': 'yearn-finance',
    'lido': 'lido',
    'ether.fi': 'ether-fi',
    'balancer': 'balancer',
    'compound': 'compound-finance',
    'convex': 'convex-finance',
    'sky': 'sky-lending',
    'maker': 'makerdao',
  };

  const key = nameMap[protocolName.toLowerCase()] || protocolName.toLowerCase();
  const pools = yields[key];
  if (!pools || pools.length === 0) return null;

  // Map Rabby chain to DeFiLlama chain
  const chainMap = {
    ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum',
    optimism: 'optimism', polygon: 'polygon', bsc: 'bsc',
    avalanche: 'avalanche', fantom: 'fantom',
  };
  const dlChain = chainMap[rabbyChain] || rabbyChain;

  // Try to match by supply token symbol + chain
  if (supplyTokens && supplyTokens.length > 0) {
    const symbols = supplyTokens.map(t => t.symbol.toUpperCase());
    for (const pool of pools) {
      if (pool.chain === dlChain && symbols.some(s => pool.symbol.includes(s) || s.includes(pool.symbol))) {
        return pool.apy;
      }
    }
  }

  // Fallback: highest TVL pool on matching chain
  const chainPools = pools.filter(p => p.chain === dlChain);
  if (chainPools.length > 0) {
    chainPools.sort((a, b) => b.tvlUsd - a.tvlUsd);
    return chainPools[0].apy;
  }

  // Fallback: highest TVL pool overall
  pools.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return pools[0].apy || null;
}

// ═══════════════════════════════════════════
// API CALLS — direct from browser (both CORS-enabled)
// ═══════════════════════════════════════════

// Rate-limited fetch with caching + exponential backoff retry.
// Caches responses in localStorage with TTL to avoid hammering APIs.
// On 429, retries with exponential backoff (2s, 4s, 8s).
async function cachedFetch(url, { cacheKey, skipCache = false } = {}) {
  // Check cache first
  if (cacheKey && !skipCache) {
    try {
      const cached = localStorage.getItem(`wallaby_cache_${cacheKey}`);
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < CACHE_TTL) {
          return data;
        }
      }
    } catch (e) { /* cache miss, continue to fetch */ }
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      // Cache the response
      if (cacheKey) {
        try {
          localStorage.setItem(`wallaby_cache_${cacheKey}`, JSON.stringify({ data, timestamp: Date.now() }));
        } catch (e) { /* localStorage might be full, skip caching */ }
      }
      return data;
    }

    if (res.status === 429) {
      lastError = new Error('Rate limited by API. Retrying...');
      continue; // retry with backoff
    }

    // Non-429 error — don't retry
    throw new Error(`API error: ${res.status}`);
  }

  // All retries exhausted — try to return stale cache
  if (cacheKey) {
    try {
      const cached = localStorage.getItem(`wallaby_cache_${cacheKey}`);
      if (cached) {
        const { data } = JSON.parse(cached);
        return data; // return stale data rather than failing
      }
    } catch (e) { /* no stale cache */ }
  }

  throw lastError || new Error('Max retries exceeded');
}

// EVM: Rabby API — full DeFi positions
// protocolsData = optional DeFiLlama protocols lookup (for accurate TVL + category labels)
async function fetchRabbyPositions(address, protocolsData) {
  const data = await cachedFetch(`${RABBY_API}/v1/user/complex_protocol_list?id=${encodeURIComponent(address)}`, { cacheKey: `rabby_pos_${address}` });
  const positions = [];

  (data || []).forEach(protocol => {
    const chain = RABBY_CHAIN_MAP[protocol.chain] || protocol.chain || 'unknown';
    const protocolName = protocol.name || 'Unknown';
    const protocolLogo = protocol.logo_url || null;
    const siteUrl = protocol.site_url || null;
    const rabbyTvl = protocol.tvl || 0;

    // Look up DeFiLlama for accurate TVL + category
    const llama = protocolsData ? matchLlamaProtocol(protocolsData, protocolName) : null;
    const accurateTvl = llama && llama.tvl ? llama.tvl : rabbyTvl;
    const llamaCategory = llama ? llama.category : '';
    const llamaSlug = llama ? llama.slug : '';

    (protocol.portfolio_item_list || []).forEach(item => {
      const stats = item.stats || {};
      const detail = item.detail || {};
      const detailTypes = item.detail_types || [];
      const pool = item.pool || {};

      // Determine position type — prefer DeFiLlama category, then detail_types, then protocol name inference
      let posType = item.name || 'Position';

      // 1. Try DeFiLlama category first (most accurate)
      const catLabel = categoryToLabel(llamaCategory);
      if (catLabel) {
        posType = catLabel;
      }
      // 2. Try detail_types (Rabby's own classification)
      else if (detailTypes.includes('lending')) posType = 'Lending';
      else if (detailTypes.includes('yield')) posType = 'Yield';
      else if (detailTypes.includes('staking')) posType = 'Staking';
      else if (detailTypes.includes('farming')) posType = 'Farming';
      else if (detailTypes.includes('pool')) posType = 'LP';
      else if (detailTypes.includes('vault')) posType = 'Vault';
      // 3. Fall back to protocol name inference
      else if (detailTypes.includes('common') || !catLabel) {
        const meaningfulTypes = detailTypes.filter(t => !['common', 'unknown'].includes(t));
        if (meaningfulTypes.length > 0) {
          posType = meaningfulTypes[0].charAt(0).toUpperCase() + meaningfulTypes[0].slice(1);
        } else {
          const pn = protocolName.toLowerCase();
          if (pn.includes('pendle')) posType = 'Yield';
          else if (pn.includes('aave') || pn.includes('compound') || pn.includes('spark') || pn.includes('maker') || pn.includes('moonwell')) posType = 'Lending';
          else if (pn.includes('morpho') || pn.includes('yearn') || pn.includes('vault')) posType = 'Yield';
          else if (pn.includes('uniswap') || pn.includes('curve') || pn.includes('balancer') || pn.includes('sushi') || pn.includes('pancake') || pn.includes('aerodrome')) posType = 'LP';
          else if (pn.includes('lido') || pn.includes('etherfi') || pn.includes('rocket')) posType = 'Liquid Staking';
          else posType = 'Position';
        }
      }

      // Extract supply tokens
      const supplyTokens = (detail.supply_token_list || []).map(t => ({
        symbol: t.symbol, amount: parseFloat(t.amount || 0), price: parseFloat(t.price || 0),
      }));

      // Extract reward tokens
      const rewardTokens = (detail.reward_token_list || []).map(t => ({
        symbol: t.symbol, amount: parseFloat(t.amount || 0), price: parseFloat(t.price || 0),
      }));

      // Extract debt tokens
      const debtTokens = (detail.debt_token_list || []).map(t => ({
        symbol: t.symbol, amount: parseFloat(t.amount || 0), price: parseFloat(t.price || 0),
      }));

      // Build deep link to the actual vault/position where you can deposit/withdraw
      const poolAddr = pool.id || pool.controller || null;
      const protocolId = protocol.id || '';
      const adapterId = pool.adapter_id || '';
      const rabbyChain = protocol.chain || '';
      const deepLink = buildPositionUrl(protocolId, adapterId, rabbyChain, poolAddr, siteUrl, supplyTokens);

      // Build asset chart URL from first supply token
      const primarySymbol = supplyTokens.length > 0 ? supplyTokens[0].symbol : '';
      const assetChartUrl = buildAssetChartUrl(primarySymbol, chain);

      // Build DeFiLlama URL for protocol TVL
      const defiLlamaUrl = buildDefiLlamaUrl(protocolName, chain, llamaSlug);

      // Build explorer URL for pool contract
      const explorerUrl = buildExplorerUrl(rabbyChain, poolAddr);

      positions.push({
        chain,
        protocol: protocolName,
        protocolId,
        protocolLogo,
        siteUrl,
        tvl: accurateTvl,
        llamaSlug,
        llamaCategory,
        type: posType,
        valueUsd: parseFloat(stats.net_usd_value || 0),
        assetUsd: parseFloat(stats.asset_usd_value || 0),
        debtUsd: parseFloat(stats.debt_usd_value || 0),
        supplyTokens,
        rewardTokens,
        debtTokens,
        healthRate: detail.health_rate != null ? parseFloat(detail.health_rate) : null,
        poolAddress: poolAddr,
        poolAdapter: adapterId,
        rabbyChain,
        url: deepLink,
        assetChartUrl,
        defiLlamaUrl,
        explorerUrl,
      });
    });
  });

  return positions;
}

// EVM: Rabby API — total balance
async function fetchRabbyNetWorth(address) {
  try {
    const data = await cachedFetch(`${RABBY_API}/v1/user/total_balance?id=${encodeURIComponent(address)}`, { cacheKey: `rabby_nw_${address}` });
    const chainBreakdown = {};
    (data.chain_list || []).forEach(c => {
      if (c.usd_value > 0) {
        const key = RABBY_CHAIN_MAP[c.id] || c.id;
        chainBreakdown[key] = c.usd_value;
      }
    });
    return { totalUsd: data.total_usd_value || 0, chainBreakdown };
  } catch (e) {
    return { totalUsd: 0, chainBreakdown: {} };
  }
}

// Solana: Mobula API — token portfolio with PnL
// NOTE: Mobula demo API is flaky with some Solana addresses (400/500 errors).
// We catch gracefully and return empty positions rather than crashing.
async function fetchMobulaPositions(address) {
  try {
    const data = await cachedFetch(`${MOBULA_API}/1/wallet/portfolio?wallet=${encodeURIComponent(address)}&blockchains=solana`, { cacheKey: `mobula_pos_${address}` });
    const d = data.data || data;
    const positions = [];

    (d.assets || []).forEach(asset => {
      const token = asset.asset || {};
      const balance = parseFloat(asset.token_balance || 0);
      const valueUsd = parseFloat(asset.estimated_balance || 0);

      // Skip dust (< $0.01)
      if (valueUsd < 0.01) return;

      positions.push({
        chain: 'solana',
        protocol: token.name || 'Solana Token',
        protocolLogo: token.logo || null,
        siteUrl: null,
        tvl: 0,
        type: 'Holdings',
        valueUsd,
        amount: balance,
        token: token.symbol || '',
        price: parseFloat(asset.price || 0),
        realizedPnl: parseFloat(asset.realized_pnl || 0),
        unrealizedPnl: parseFloat(asset.unrealized_pnl || 0),
        url: `https://solscan.io/account/${encodeURIComponent(address)}`,
      });
    });

    return positions;
  } catch (e) {
    // Mobula might return 400/500 for some Solana addresses — don't crash
    console.log('Mobula fetch failed for', address, e.message);
    return [];
  }
}

// Solana: Mobula API — net worth
async function fetchMobulaNetWorth(address) {
  try {
    const data = await cachedFetch(`${MOBULA_API}/1/wallet/portfolio?wallet=${encodeURIComponent(address)}&blockchains=solana`, { cacheKey: `mobula_nw_${address}` });
    const d = data.data || data;
    const totalUsd = d.total_wallet_balance || 0;
    return { totalUsd, chainBreakdown: { solana: totalUsd } };
  } catch (e) {
    return { totalUsd: 0, chainBreakdown: {} };
  }
}

// ═══════════════════════════════════════════
// ASSET CHART URL BUILDER
// ═══════════════════════════════════════════
// Common coins → TradingView, obscure/PT tokens → DexScreener
const COMMON_TICKERS = new Set([
  'BTC','ETH','USDC','USDT','DAI','WBTC','WETH','BNB','MATIC','ARB','OP','BASE',
  'LINK','UNI','AAVE','COMP','CRV','CVX','YFI','SUSHI','CAKE','LDO','RPL','EIGEN',
  'RETH','STETH','CBETH','WSTETH','SOL','JUP','PYTH','JTO','BONK','WIF',
  'AVAX','FTM','SPEED','GLMR','CELO','XDAI','MNT','BLAST','ZORA',
  'USDE','SUSDE','DEUSD','PT-USDC','PT-WSUSDE','YT-WSUSDE',
]);

function buildAssetChartUrl(symbol, chain) {
  if (!symbol) return null;
  const sym = symbol.toUpperCase();

  // Stablecoins and common majors → TradingView
  const tvPairs = {
    BTC: 'BINANCE:BTCUSDT', ETH: 'BINANCE:ETHUSDT', WETH: 'BINANCE:ETHUSDT',
    WBTC: 'BINANCE:BTCUSDT', USDC: 'BINANCE:USDCUSDT', USDT: 'BINANCE:USDTUSDT',
    DAI: 'BINANCE:DAIUSDT', BNB: 'BINANCE:BNBUSDT', MATIC: 'BINANCE:MATICUSDT',
    ARB: 'BINANCE:ARBUSDT', OP: 'BINANCE:OPUSDT', AVAX: 'BINANCE:AVAXUSDT',
    LINK: 'BINANCE:LINKUSDT', UNI: 'BINANCE:UNIUSDT', AAVE: 'BINANCE:AAVEUSDT',
    COMP: 'BINANCE:COMPUSDT', CRV: 'BINANCE:CRVUSDT', LDO: 'BINANCE:LDOUSDT',
    SOL: 'BINANCE:SOLUSDT', JUP: 'BINANCE:JUPUSDT', EIGEN: 'BINANCE:EIGENUSDT',
  };
  if (tvPairs[sym]) return `https://www.tradingview.com/chart/?symbol=${tvPairs[sym]}`;

  // Liquid staking → TradingView via staking derivative
  if (['STETH','RETH','CBETH','WSTETH','RPL'].includes(sym)) return `https://www.tradingview.com/chart/?symbol=BINANCE:ETHUSDT`;

  // Stablecoin variants → TradingView USDC
  if (['USDE','SUSDE','DEUSD'].includes(sym)) return `https://www.tradingview.com/chart/?symbol=BINANCE:USDCUSDT`;

  // Everything else (PT tokens, obscure) → DexScreener
  const chainMap = {
    ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum', optimism: 'optimism',
    polygon: 'polygon', bsc: 'bsc', avalanche: 'avalanche', fantom: 'fantom',
    linea: 'linea', scroll: 'scroll', blast: 'blast', zksync: 'zksync',
    solana: 'solana', moonbeam: 'moonbeam', celo: 'celo', gnosis: 'gnosis',
  };
  const dsChain = chainMap[chain] || 'ethereum';
  return `https://dexscreener.com/${dsChain}?q=${encodeURIComponent(sym)}`;
}

// ═══════════════════════════════════════════
// DEFILLAMA PROTOCOL URL
// ═══════════════════════════════════════════
function buildDefiLlamaUrl(protocolName, chain, llamaSlug) {
  // If we have the actual slug from DeFiLlama API, use it
  if (llamaSlug) return `https://defillama.com/protocol/${llamaSlug}`;
  if (!protocolName) return null;
  // Fallback: map common protocol names to DeFiLlama slugs
  const slugMap = {
    'aave v2': 'aave-v2', 'aave v3': 'aave-v3', 'aave': 'aave-v3',
    'compound': 'compound-v3', 'compound v3': 'compound-v3', 'compound v2': 'compound-v2',
    'uniswap': 'uniswap-v3', 'uniswap v2': 'uniswap-v2', 'uniswap v3': 'uniswap-v3',
    'curve': 'curve-dex', 'curve finance': 'curve-dex',
    'yearn': 'yearn-finance', 'yearn v3': 'yearn-finance',
    'lido': 'lido', 'ether.fi': 'ether-fi', 'etherfi': 'ether-fi',
    'balancer': 'balancer', 'convex': 'convex-finance',
    'pancakeswap': 'pancakeswap', 'sushiswap': 'sushiswap',
    'quickswap': 'quickswap', 'spark': 'spark-protocol',
    'maker': 'makerdao', 'makerdao': 'makerdao', 'sky': 'sky-lending',
    'morpho': 'morpho-blue', 'morpho blue': 'morpho-blue',
    'rocket pool': 'rocket-pool', 'rocketpool': 'rocket-pool',
    'stargate': 'stargate', 'aerodrome': 'aerodrome',
    'pendle': 'pendle', 'extra finance': 'extra-finance',
    'moonwell': 'moonwell-lending', 'moonwell lending': 'moonwell-lending',
    'moonwell vaults': 'moonwell-vaults',
  };
  const pn = protocolName.toLowerCase();
  const slug = slugMap[pn] || slugMap[pn.split(' ')[0]] || pn.replace(/\s+/g, '-');
  return `https://defillama.com/protocol/${slug}`;
}

// ═══════════════════════════════════════════
// EXPLORER URL FOR POOL CONTRACT
// ═══════════════════════════════════════════
function buildExplorerUrl(rabbyChain, poolAddr) {
  if (!poolAddr) return null;
  const explorer = RABBY_CHAIN_EXPLORER[rabbyChain];
  if (!explorer) return null;
  return explorer + poolAddr;
}

// ═══════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════
function fmtUsd(val) {
  if (val == null || isNaN(val)) return '—';
  if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
  if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K`;
  return `$${val.toFixed(2)}`;
}

function fmtTokenAmount(val) {
  if (val == null || isNaN(val)) return '—';
  if (val >= 1e6) return `${(val / 1e6).toFixed(2)}M`;
  if (val >= 1e3) return `${(val / 1e3).toFixed(2)}K`;
  return val.toFixed(4).replace(/\.?0+$/, '');
}

function fmtTokenList(tokens) {
  if (!tokens || tokens.length === 0) return '';
  return tokens.map(t => `${fmtTokenAmount(t.amount)} ${t.symbol}`).join(', ');
}

// ═══════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════
function showState(stateName) {
  ['loading-state', 'empty-state', 'error-state', 'summary-section', 'positions-container', 'farming-section', 'swap-section'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  const map = {
    loading: 'loading-state',
    empty: 'empty-state',
    error: 'error-state',
    positions: ['summary-section', 'positions-container', 'farming-section', 'swap-section'],
  };
  const targets = map[stateName] || [];
  (Array.isArray(targets) ? targets : [targets]).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  });
}

function renderWalletTabs() {
  const section = document.getElementById('wallet-tabs-section');
  const tabsContainer = document.getElementById('wallet-tabs');

  if (state.wallets.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  tabsContainer.innerHTML = '';

  state.wallets.forEach((w, idx) => {
    const tab = document.createElement('div');
    tab.className = 'wallet-tab' + (idx === state.activeWalletIdx ? ' active' : '');
    tab.innerHTML = `
      <span class="wallet-label">${w.label || shortenAddress(w.address)}</span>
      <span class="wallet-chain-tag">${w.chain === 'solana' ? 'SOL' : 'EVM'}</span>
      <button class="wallet-remove" title="Remove wallet" data-idx="${idx}">✕</button>
    `;
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('wallet-remove')) return;
      state.activeWalletIdx = idx;
      state.activeChainFilter = 'all';
      renderWalletTabs();
      renderPositions();
    });
    tabsContainer.appendChild(tab);
  });

  tabsContainer.querySelectorAll('.wallet-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      state.wallets.splice(idx, 1);
      if (state.activeWalletIdx >= state.wallets.length) {
        state.activeWalletIdx = Math.max(0, state.wallets.length - 1);
      }
      saveWallets();
      renderWalletTabs();
      if (state.wallets.length === 0) {
        showState('empty');
        document.getElementById('chain-filters').style.display = 'none';
      } else {
        renderPositions();
      }
    });
  });
}

function renderChainFilters(positions) {
  const container = document.getElementById('chain-filters');
  const chains = [...new Set(positions.map(p => p.chain))];

  if (chains.length <= 1) {
    container.style.display = 'none';
    return;
  }

  container.style.display = '';
  container.innerHTML = '<button class="chain-pill active" data-chain="all">All Chains</button>';

  chains.forEach(chain => {
    const meta = CHAIN_META[chain] || { name: chain, icon: '⚪' };
    const pill = document.createElement('button');
    pill.className = 'chain-pill';
    pill.dataset.chain = chain;
    pill.textContent = `${meta.icon} ${meta.name}`;
    container.appendChild(pill);
  });

  container.querySelectorAll('.chain-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      container.querySelectorAll('.chain-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.activeChainFilter = pill.dataset.chain;
      renderPositions();
    });
  });
}

function renderSummary(positions, netWorth) {
  const totalUsd = netWorth?.totalUsd || positions.reduce((sum, p) => sum + (p.valueUsd || 0), 0);
  const chains = new Set(positions.map(p => p.chain));
  const protocols = new Set(positions.map(p => p.protocol));

  // Calculate APYs from positions that have apy data
  const apyValues = positions.map(p => p.apy).filter(a => a != null && a > 0);
  let bestApy = 0;
  let avgApy = 0;
  if (apyValues.length > 0) {
    bestApy = Math.max(...apyValues);
    avgApy = apyValues.reduce((sum, a) => sum + a, 0) / apyValues.length;
  }

  document.getElementById('net-worth').textContent = fmtUsd(totalUsd);
  document.getElementById('total-positions').textContent = positions.length;
  document.getElementById('chains-active').textContent = chains.size;
  document.getElementById('protocols-count').textContent = protocols.size;
  document.getElementById('best-apy').textContent = bestApy > 0 ? `${bestApy.toFixed(2)}%` : '—';
  document.getElementById('avg-apy').textContent = avgApy > 0 ? `${avgApy.toFixed(2)}%` : '—';
}

function renderPositions() {
  const wallet = state.wallets[state.activeWalletIdx];
  if (!wallet) { showState('empty'); return; }

  if (wallet.loading) { showState('loading'); return; }

  const positions = wallet.positions || [];
  const netWorth = wallet.netWorth || null;

  if (positions.length === 0) {
    showState('empty');
    document.querySelector('.empty-state h2').textContent = 'No positions found';
    document.querySelector('.empty-state p').textContent = wallet.error
      ? wallet.error
      : 'This wallet has no DeFi positions, or the data is still loading.';
    return;
  }

  // Filter by chain
  const filtered = state.activeChainFilter === 'all'
    ? positions
    : positions.filter(p => p.chain === state.activeChainFilter);

  renderSummary(positions, netWorth);
  renderChainFilters(positions);

  const container = document.getElementById('positions-container');
  container.innerHTML = '';

  // Group by chain
  const byChain = {};
  filtered.forEach(p => {
    const chain = p.chain || 'unknown';
    if (!byChain[chain]) byChain[chain] = [];
    byChain[chain].push(p);
  });

  // Sort chains by total value
  const sortedChains = Object.entries(byChain).sort((a, b) => {
    const sumA = a[1].reduce((s, p) => s + (p.valueUsd || 0), 0);
    const sumB = b[1].reduce((s, p) => s + (p.valueUsd || 0), 0);
    return sumB - sumA;
  });

  sortedChains.forEach(([chain, chainPositions]) => {
    const meta = CHAIN_META[chain] || { name: chain, icon: '⚪', color: '#888' };
    const chainTotal = chainPositions.reduce((s, p) => s + (p.valueUsd || 0), 0);

    const group = document.createElement('div');
    group.className = 'chain-group';
    group.innerHTML = `
      <div class="chain-group-header">
        <span class="chain-icon" style="background:${meta.color}22; border: 1px solid ${meta.color}44;">${meta.icon}</span>
        <span class="chain-name">${meta.name}</span>
        <span class="chain-tvl">${fmtUsd(chainTotal)}</span>
      </div>
    `;

    chainPositions.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));

    chainPositions.forEach(pos => {
      const card = document.createElement('div');
      card.className = 'position-card collapsed';

      const logoUrl = pos.protocolLogo || null;
      const meta = CHAIN_META[pos.chain] || CHAIN_META[chain];

      // ── Collapsed view: protocol name, type, value ──
      let tokenDetail = '';
      if (pos.supplyTokens && pos.supplyTokens.length > 0) {
        tokenDetail = fmtTokenList(pos.supplyTokens);
      } else if (pos.token) {
        tokenDetail = `${fmtTokenAmount(pos.amount || 0)} ${pos.token}`;
      }

      let healthHtml = '';
      if (pos.healthRate != null && pos.healthRate > 0) {
        const hr = pos.healthRate > 1e30 ? '∞' : (pos.healthRate / 1e18).toFixed(2);
        const hrClass = (pos.healthRate / 1e18) < 1.5 ? 'health-warning' : 'health-ok';
        healthHtml = `<span class="position-health ${hrClass}">Health ${hr}</span>`;
      }

      let debtHtml = '';
      if (pos.debtUsd && pos.debtUsd > 0) {
        debtHtml = `<span class="position-debt">Debt ${fmtUsd(pos.debtUsd)}</span>`;
      }

      let rewardHtml = '';
      if (pos.rewardTokens && pos.rewardTokens.length > 0) {
        rewardHtml = `<span class="position-rewards">🎁 ${pos.rewardTokens.length} reward</span>`;
      }

      let pnlHtml = '';
      if (pos.realizedPnl != null || pos.unrealizedPnl != null) {
        const totalPnl = (pos.realizedPnl || 0) + (pos.unrealizedPnl || 0);
        const pnlClass = totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative';
        const sign = totalPnl >= 0 ? '+' : '';
        pnlHtml = `<span class="position-pnl ${pnlClass}">PnL ${sign}${fmtUsd(Math.abs(totalPnl))}</span>`;
      }

      // ── Expanded view: detailed position data ──
      let detailRows = '';

      // Supply tokens breakdown
      if (pos.supplyTokens && pos.supplyTokens.length > 0) {
        detailRows += `
          <div class="position-detail-row">
            <span class="detail-label">Supply</span>
            <span class="detail-value">${pos.supplyTokens.map(t => `${fmtTokenAmount(t.amount)} ${t.symbol} ($${(t.amount * t.price).toFixed(2)})`).join('<br>')}</span>
          </div>`;
      }

      // Debt tokens breakdown
      if (pos.debtTokens && pos.debtTokens.length > 0) {
        detailRows += `
          <div class="position-detail-row">
            <span class="detail-label">Debt</span>
            <span class="detail-value debt">${pos.debtTokens.map(t => `${fmtTokenAmount(t.amount)} ${t.symbol} ($${(t.amount * t.price).toFixed(2)})`).join('<br>')}</span>
          </div>`;
      }

      // Reward tokens breakdown
      if (pos.rewardTokens && pos.rewardTokens.length > 0) {
        detailRows += `
          <div class="position-detail-row">
            <span class="detail-label">Rewards</span>
            <span class="detail-value reward">${pos.rewardTokens.map(t => `${fmtTokenAmount(t.amount)} ${t.symbol} ($${(t.amount * t.price).toFixed(2)})`).join('<br>')}</span>
          </div>`;
      }

      // Token holdings (Solana)
      if (pos.token && pos.amount) {
        detailRows += `
          <div class="position-detail-row">
            <span class="detail-label">Balance</span>
            <span class="detail-value">${fmtTokenAmount(pos.amount)} ${pos.token}</span>
          </div>`;
      }

      if (pos.price) {
        detailRows += `
          <div class="position-detail-row">
            <span class="detail-label">Price</span>
            <span class="detail-value">$${pos.price.toFixed(pos.price < 1 ? 6 : 2)}</span>
          </div>`;
      }

      // Asset vs debt vs net
      if (pos.assetUsd != null && pos.assetUsd > 0) {
        const assetLink = pos.assetChartUrl
          ? `<a href="${pos.assetChartUrl}" target="_blank" rel="noopener noreferrer" class="detail-value detail-linkable" title="View chart ↗">${fmtUsd(pos.assetUsd)}</a>`
          : `<span class="detail-value">${fmtUsd(pos.assetUsd)}</span>`;
        detailRows += `
          <div class="position-detail-row">
            <span class="detail-label">Asset Value</span>
            ${assetLink}
          </div>`;
      }

      if (pos.debtUsd != null && pos.debtUsd > 0) {
        detailRows += `
          <div class="position-detail-row">
            <span class="detail-label">Debt Value</span>
            <span class="detail-value debt">${fmtUsd(pos.debtUsd)}</span>
          </div>`;
      }

      if (pos.healthRate != null && pos.healthRate > 0) {
        const hr = pos.healthRate > 1e30 ? '∞' : (pos.healthRate / 1e18).toFixed(2);
        detailRows += `
          <div class="position-detail-row">
            <span class="detail-label">Health Rate</span>
            <span class="detail-value">${hr}</span>
          </div>`;
      }

      // APY (from DeFiLlama enrichment)
      if (pos.apy != null && pos.apy > 0) {
        detailRows += `
          <div class="position-detail-row">
            <span class="detail-label">APY</span>
            <span class="detail-value positive">${pos.apy.toFixed(2)}%</span>
          </div>`;
      }

      // Pool contract address — link to explorer + click to copy
      if (pos.poolAddress) {
        const shortPool = pos.poolAddress.slice(0, 8) + '...' + pos.poolAddress.slice(-6);
        const explorerHref = pos.explorerUrl || '#';
        detailRows += `
          <div class="position-detail-row">
            <span class="detail-label">Pool Contract</span>
            <span class="detail-value mono">
              <a href="${explorerHref}" target="_blank" rel="noopener noreferrer" class="pool-link" title="View on explorer ↗">${shortPool}</a>
              <button class="copy-btn" data-copy="${pos.poolAddress}" title="Copy address">⎘</button>
            </span>
          </div>`;
      }

      // TVL of the protocol — link to DeFiLlama
      if (pos.tvl && pos.tvl > 0) {
        const tvlLink = pos.defiLlamaUrl
          ? `<a href="${pos.defiLlamaUrl}" target="_blank" rel="noopener noreferrer" class="detail-linkable" title="View on DeFiLlama ↗">${fmtUsd(pos.tvl)}</a>`
          : `<span>${fmtUsd(pos.tvl)}</span>`;
        detailRows += `
          <div class="position-detail-row">
            <span class="detail-label">Protocol TVL</span>
            <span class="detail-value">${tvlLink}</span>
          </div>`;
      }

      // PnL breakdown (Solana)
      if (pos.realizedPnl != null || pos.unrealizedPnl != null) {
        if (pos.realizedPnl) {
          const cls = pos.realizedPnl >= 0 ? 'positive' : 'negative';
          detailRows += `
            <div class="position-detail-row">
              <span class="detail-label">Realized PnL</span>
              <span class="detail-value ${cls}">${pos.realizedPnl >= 0 ? '+' : ''}${fmtUsd(pos.realizedPnl)}</span>
            </div>`;
        }
        if (pos.unrealizedPnl) {
          const cls = pos.unrealizedPnl >= 0 ? 'positive' : 'negative';
          detailRows += `
            <div class="position-detail-row">
              <span class="detail-label">Unrealized PnL</span>
              <span class="detail-value ${cls}">${pos.unrealizedPnl >= 0 ? '+' : ''}${fmtUsd(pos.unrealizedPnl)}</span>
            </div>`;
        }
      }

      // Deep links
      let linksHtml = '';
      if (pos.url) {
        linksHtml += `<a href="${pos.url}" target="_blank" rel="noopener noreferrer" class="detail-link">View Position ↗</a>`;
      }
      if (pos.siteUrl && pos.url !== pos.siteUrl) {
        linksHtml += `<a href="${pos.siteUrl}" target="_blank" rel="noopener noreferrer" class="detail-link">Protocol Site ↗</a>`;
      }

      card.innerHTML = `
        <div class="position-card-header">
          <div class="position-icon">
            ${logoUrl ? `<img src="${logoUrl}" alt="" onerror="this.style.display='none';this.parentElement.textContent='📦'">` : '📦'}
          </div>
          <div class="position-info">
            <div class="position-protocol">${pos.protocol || 'Unknown'}</div>
            <div class="position-type">${pos.type || 'Position'}${tokenDetail ? ' · ' + tokenDetail : ''}</div>
            <div class="position-tags">${healthHtml}${debtHtml}${rewardHtml}${pnlHtml}</div>
          </div>
          <div class="position-value">
            <div class="position-amount">${fmtUsd(pos.valueUsd)}</div>
            ${pos.apy != null && pos.apy > 0 ? `<div class="position-apy">${pos.apy.toFixed(2)}% APY</div>` : ''}
            ${detailRows || linksHtml ? '<span class="position-chevron">⌄</span>' : ''}
          </div>
        </div>
        ${detailRows || linksHtml ? `
          <div class="position-detail">
            ${detailRows ? `<div class="position-detail-grid">${detailRows}</div>` : ''}
            ${linksHtml ? `<div class="position-detail-links">${linksHtml}</div>` : ''}
          </div>
        ` : ''}
      `;

      // Click to expand/collapse (only if there's detail to show)
      if (detailRows || linksHtml) {
        card.addEventListener('click', (e) => {
          if (e.target.tagName === 'A' || e.target.closest('a') || e.target.classList.contains('copy-btn')) return;
          card.classList.toggle('collapsed');
          card.classList.toggle('expanded');
          const chevron = card.querySelector('.position-chevron');
          if (chevron) chevron.textContent = card.classList.contains('expanded') ? '⌃' : '⌄';
        });
      }

      // Copy pool address to clipboard
      card.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const addr = btn.dataset.copy;
          navigator.clipboard.writeText(addr).then(() => {
            const orig = btn.textContent;
            btn.textContent = '✓';
            btn.classList.add('copied');
            setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1200);
          }).catch(() => {});
        });
      });

      group.appendChild(card);
    });

    container.appendChild(group);
  });

  showState('positions');
}

// ═══════════════════════════════════════════
// WALLET MANAGEMENT
// ═══════════════════════════════════════════
async function addWallet() {
  const input = document.getElementById('wallet-address');
  const chainSelect = document.getElementById('chain-select');
  const address = input.value.trim();
  const chainPref = chainSelect.value;

  if (!address) return;

  let chain = chainPref;
  if (chain === 'auto') {
    const detected = detectChain(address);
    if (!detected) {
      showError('Could not detect chain. Please select EVM or Solana manually.');
      return;
    }
    chain = detected;
  }

  if (state.wallets.some(w => w.address.toLowerCase() === address.toLowerCase())) {
    showError('This wallet is already added.');
    return;
  }

  const wallet = {
    address,
    chain,
    label: '',
    positions: [],
    netWorth: null,
    loading: false,
  };

  state.wallets.push(wallet);
  state.activeWalletIdx = state.wallets.length - 1;
  state.activeChainFilter = 'all';
  saveWallets();
  renderWalletTabs();

  input.value = '';
  await loadPositionsForWallet(state.activeWalletIdx);
}

async function loadPositionsForWallet(idx) {
  const wallet = state.wallets[idx];
  if (!wallet) return;

  wallet.loading = true;
  if (idx === state.activeWalletIdx) showState('loading');

  try {
    if (wallet.chain === 'solana') {
      // Solana: use Mobula
      const [posRes, nwRes] = await Promise.allSettled([
        fetchMobulaPositions(wallet.address),
        fetchMobulaNetWorth(wallet.address),
      ]);
      wallet.positions = posRes.status === 'fulfilled' ? posRes.value : [];
      wallet.netWorth = nwRes.status === 'fulfilled' ? nwRes.value : null;
      if (posRes.status === 'rejected') {
        wallet.error = posRes.reason.message;
      }
    } else {
      // EVM: use Rabby + enrich with DeFiLlama APYs + accurate TVL/categories
      const [posRes, nwRes, yieldsRes, protocolsRes] = await Promise.allSettled([
        fetchRabbyPositions(wallet.address),
        fetchRabbyNetWorth(wallet.address),
        fetchLlamaYields(),
        fetchLlamaProtocols(),
      ]);
      wallet.positions = posRes.status === 'fulfilled' ? posRes.value : [];
      wallet.netWorth = nwRes.status === 'fulfilled' ? nwRes.value : null;

      // Enrich positions with DeFiLlama accurate TVL + category labels
      const protocolsData = protocolsRes.status === 'fulfilled' ? protocolsRes.value : {};
      if (protocolsData && Object.keys(protocolsData).length > 0 && wallet.positions.length > 0) {
        wallet.positions.forEach(pos => {
          const llama = matchLlamaProtocol(protocolsData, pos.protocol);
          if (llama) {
            // Override TVL with accurate DeFiLlama value
            if (llama.tvl) pos.tvl = llama.tvl;
            if (llama.slug) {
              pos.llamaSlug = llama.slug;
              pos.defiLlamaUrl = `https://defillama.com/protocol/${llama.slug}`;
            }
            // Override type with DeFiLlama category if available
            const catLabel = categoryToLabel(llama.category);
            if (catLabel) pos.type = catLabel;
          }
        });
      }

      // Enrich positions with APY from DeFiLlama
      if (yieldsRes.status === 'fulfilled' && wallet.positions.length > 0) {
        const yields = yieldsRes.value;
        wallet.positions.forEach(pos => {
          if (pos.apy == null) {
            const matchedApy = matchApy(yields, pos.protocol, pos.chain, pos.supplyTokens);
            if (matchedApy != null) pos.apy = matchedApy;
          }
        });
      }

      if (posRes.status === 'rejected') {
        wallet.error = posRes.reason.message;
      }
    }

    wallet.loading = false;
    wallet.lastUpdated = Date.now();

    if (idx === state.activeWalletIdx) {
      if (wallet.error && wallet.positions.length === 0) {
        showError(wallet.error);
      } else {
        renderPositions();
      }
    }
  } catch (err) {
    wallet.loading = false;
    if (idx === state.activeWalletIdx) showError(err.message);
  }
}

function showError(msg) {
  showState('error');
  document.getElementById('error-message').textContent = msg;
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
function init() {
  loadWallets();

  document.getElementById('add-wallet-btn').addEventListener('click', addWallet);
  document.getElementById('wallet-address').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addWallet();
  });

  if (state.wallets.length > 0) {
    renderWalletTabs();
    loadPositionsForWallet(state.activeWalletIdx);
  } else {
    showState('empty');
  }
}

document.addEventListener('DOMContentLoaded', init);