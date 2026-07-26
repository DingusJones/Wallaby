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

const CHAIN_META = {
  ethereum:  { name: 'Ethereum',  icon: '🔷', color: '#627eea' },
  base:      { name: 'Base',      icon: '🔵', color: '#0052ff' },
  arbitrum:  { name: 'Arbitrum',  icon: '🟦', color: '#28a0f0' },
  optimism:  { name: 'Optimism',  icon: '🔴', color: '#ff0420' },
  polygon:   { name: 'Polygon',   icon: '🟣', color: '#8247e5' },
  bsc:       { name: 'BNB Chain', icon: '🟡', color: '#f0b90b' },
  avalanche: { name: 'Avalanche', icon: '🔺', color: '#e84142' },
  fantom:    { name: 'Fantom',    icon: '👻', color: '#1969ff' },
  linea:     { name: 'Linea',     icon: '⚫', color: '#61dfff' },
  scroll:    { name: 'Scroll',    icon: '📜', color: '#f0f0f0' },
  blast:     { name: 'Blast',     icon: '🟡', color: '#ffcf00' },
  zksync:    { name: 'zkSync',    icon: '⚪', color: '#1e69ff' },
  zora:      { name: 'Zora',      icon: '⚪', color: '#444' },
  manta:     { name: 'Manta',    icon: '🔵', color: '#00b8ff' },
  moonbeam:  { name: 'Moonbeam',  icon: '🌙', color: '#ff4757' },
  celo:      { name: 'Celo',     icon: '🟡', color: '#fbcc5c' },
  gnosis:    { name: 'Gnosis',   icon: '🟢', color: '#3e6957' },
  solana:    { name: 'Solana',   icon: '🟣', color: '#9945ff' },
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
// API CALLS — direct from browser (both CORS-enabled)
// ═══════════════════════════════════════════

// EVM: Rabby API — full DeFi positions
async function fetchRabbyPositions(address) {
  const res = await fetch(`${RABBY_API}/v1/user/complex_protocol_list?id=${encodeURIComponent(address)}`);
  if (!res.ok) {
    if (res.status === 429) throw new Error('Rabby API rate limited. Wait a moment and try again.');
    throw new Error(`Rabby API error: ${res.status}`);
  }
  const data = await res.json();
  const positions = [];

  (data || []).forEach(protocol => {
    const chain = RABBY_CHAIN_MAP[protocol.chain] || protocol.chain || 'unknown';
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
      else if (detailTypes.includes('farming')) posType = 'Farming';
      else if (detailTypes.length > 0) {
        posType = detailTypes[0].charAt(0).toUpperCase() + detailTypes[0].slice(1);
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
        url: siteUrl,
      });
    });
  });

  return positions;
}

// EVM: Rabby API — total balance
async function fetchRabbyNetWorth(address) {
  const res = await fetch(`${RABBY_API}/v1/user/total_balance?id=${encodeURIComponent(address)}`);
  if (!res.ok) return { totalUsd: 0, chainBreakdown: {} };
  const data = await res.json();
  const chainBreakdown = {};
  (data.chain_list || []).forEach(c => {
    if (c.usd_value > 0) {
      const key = RABBY_CHAIN_MAP[c.id] || c.id;
      chainBreakdown[key] = c.usd_value;
    }
  });
  return {
    totalUsd: data.total_usd_value || 0,
    chainBreakdown,
  };
}

// Solana: Mobula API — token portfolio with PnL
async function fetchMobulaPositions(address) {
  const res = await fetch(`${MOBULA_API}/1/wallet/portfolio?wallet=${encodeURIComponent(address)}&blockchains=solana`);
  if (!res.ok) throw new Error(`Mobula API error: ${res.status}`);
  const json = await res.json();
  const data = json.data || json;
  const positions = [];

  (data.assets || []).forEach(asset => {
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
      url: null,
    });
  });

  return positions;
}

// Solana: Mobula API — net worth
async function fetchMobulaNetWorth(address) {
  const res = await fetch(`${MOBULA_API}/1/wallet/portfolio?wallet=${encodeURIComponent(address)}&blockchains=solana`);
  if (!res.ok) return { totalUsd: 0, chainBreakdown: {} };
  const json = await res.json();
  const data = json.data || json;
  const totalUsd = data.total_wallet_balance || 0;
  return {
    totalUsd,
    chainBreakdown: { solana: totalUsd },
  };
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
  ['loading-state', 'empty-state', 'error-state', 'summary-section', 'positions-container'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  const map = {
    loading: 'loading-state',
    empty: 'empty-state',
    error: 'error-state',
    positions: ['summary-section', 'positions-container'],
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
  let bestApy = 0;
  positions.forEach(p => { if (p.apy && p.apy > bestApy) bestApy = p.apy; });

  document.getElementById('net-worth').textContent = fmtUsd(totalUsd);
  document.getElementById('total-positions').textContent = positions.length;
  document.getElementById('chains-active').textContent = chains.size;
  document.getElementById('protocols-count').textContent = protocols.size;
  document.getElementById('best-apy').textContent = bestApy > 0 ? `${bestApy.toFixed(2)}%` : '—';
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
    document.querySelector('.empty-state p').textContent =
      'This wallet has no DeFi positions, or the data is still loading.';
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
      const card = document.createElement('a');
      card.className = 'position-card';
      const logoUrl = pos.protocolLogo || null;

      // Build token detail line
      let tokenDetail = '';
      if (pos.supplyTokens && pos.supplyTokens.length > 0) {
        tokenDetail = fmtTokenList(pos.supplyTokens);
      } else if (pos.token) {
        tokenDetail = `${fmtTokenAmount(pos.amount || 0)} ${pos.token}`;
      }

      // Health rate for lending positions
      let healthHtml = '';
      if (pos.healthRate != null && pos.healthRate > 0) {
        const hr = pos.healthRate > 1e30 ? '∞' : (pos.healthRate / 1e18).toFixed(2);
        const hrClass = (pos.healthRate / 1e18) < 1.5 ? 'health-warning' : 'health-ok';
        healthHtml = `<span class="position-health ${hrClass}">Health ${hr}</span>`;
      }

      // Debt indicator
      let debtHtml = '';
      if (pos.debtUsd && pos.debtUsd > 0) {
        debtHtml = `<span class="position-debt">Debt ${fmtUsd(pos.debtUsd)}</span>`;
      }

      // Reward tokens indicator
      let rewardHtml = '';
      if (pos.rewardTokens && pos.rewardTokens.length > 0) {
        rewardHtml = `<span class="position-rewards">🎁 ${pos.rewardTokens.length} reward</span>`;
      }

      // PnL for Solana/Mobula positions
      let pnlHtml = '';
      if (pos.realizedPnl != null || pos.unrealizedPnl != null) {
        const totalPnl = (pos.realizedPnl || 0) + (pos.unrealizedPnl || 0);
        const pnlClass = totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative';
        const sign = totalPnl >= 0 ? '+' : '';
        pnlHtml = `<span class="position-pnl ${pnlClass}">PnL ${sign}${fmtUsd(Math.abs(totalPnl))}</span>`;
      }

      card.innerHTML = `
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
        </div>
      `;

      if (pos.url) {
        card.href = pos.url;
        card.target = '_blank';
        card.rel = 'noopener noreferrer';
      }

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
      // EVM: use Rabby
      const [posRes, nwRes] = await Promise.allSettled([
        fetchRabbyPositions(wallet.address),
        fetchRabbyNetWorth(wallet.address),
      ]);
      wallet.positions = posRes.status === 'fulfilled' ? posRes.value : [];
      wallet.netWorth = nwRes.status === 'fulfilled' ? nwRes.value : null;
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