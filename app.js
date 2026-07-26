/* Wallaby — Cross-chain wallet position viewer
   Main app logic: wallet management, API calls (via CF Worker proxy), position rendering.
   
   Data sources:
   - EVM: Rabby/DeBank API (api.rabby.io) — free, no key, 60+ chains, full DeFi positions
   - Solana: Mobula API — free demo, token holdings + PnL (PLACEHOLDER — upgrade when better free API surfaces)
   
   API key reminder: Mobula is a placeholder for Solana coverage. When a better free
   Solana DeFi position API becomes available, swap fetchMobulaPositions() in worker.js.
*/

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const CONFIG = {
  // Cloudflare Worker proxy URL — set this after deploying the worker
  proxyUrl: '', // e.g., 'https://wallaby-proxy.your-subdomain.workers.dev'

  // Chain display metadata (Rabby chain IDs mapped to display names)
  chainMeta: {
    ethereum:  { name: 'Ethereum',  icon: '🔷', color: '#627eea', explorer: 'https://etherscan.io/address/' },
    base:      { name: 'Base',      icon: '🔵', color: '#0052ff', explorer: 'https://basescan.org/address/' },
    arbitrum:  { name: 'Arbitrum',  icon: '🟦', color: '#28a0f0', explorer: 'https://arbiscan.io/address/' },
    optimism:  { name: 'Optimism',  icon: '🔴', color: '#ff0420', explorer: 'https://optimistic.etherscan.io/address/' },
    polygon:   { name: 'Polygon',   icon: '🟣', color: '#8247e5', explorer: 'https://polygonscan.com/address/' },
    bsc:       { name: 'BNB Chain', icon: '🟡', color: '#f0b90b', explorer: 'https://bscscan.com/address/' },
    avalanche: { name: 'Avalanche', icon: '🔴', color: '#e84142', explorer: 'https://snowtrace.io/address/' },
    fantom:    { name: 'Fantom',    icon: '🔵', color: '#1969ff', explorer: 'https://ftmscan.com/address/' },
    linea:     { name: 'Linea',     icon: '⚫', color: '#61dfff', explorer: 'https://lineascan.build/address/' },
    scroll:    { name: 'Scroll',   icon: '⚫', color: '#fffnfn', explorer: 'https://scrollscan.com/address/' },
    blast:     { name: 'Blast',     icon: '🟡', color: '#ffcf00', explorer: 'https://blastscan.io/address/' },
    zksync:    { name: 'zkSync',    icon: '⚪', color: '#1e69ff', explorer: 'https://explorer.zksync.io/address/' },
    zora:      { name: 'Zora',      icon: '⚪', color: '#000000', explorer: 'https://explorer.zora.energy/address/' },
    manta:     { name: 'Manta',    icon: '🔵', color: '#00b8ff', explorer: 'https://pacific-explorer.manta.network/address/' },
    moonbeam:  { name: 'Moonbeam',  icon: '🔵', color: '#ff4757', explorer: 'https://moonbeam.moonscan.io/address/' },
    celo:      { name: 'Celo',     icon: '🟡', color: '#fbcc5c', explorer: 'https://celoscan.io/address/' },
    gnosis:    { name: 'Gnosis',   icon: '🟢', color: '#3e6957', explorer: 'https://gnosisscan.io/address/' },
    solana:    { name: 'Solana',   icon: '🟣', color: '#9945ff', explorer: 'https://solscan.io/account/' },
  },
};

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
const state = {
  wallets: [],
  activeWalletIdx: 0,
  activeChainFilter: 'all',
};

// ═══════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════
const STORAGE_KEY = 'wallaby_wallets';

function loadWallets() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) state.wallets = JSON.parse(saved);
  } catch (e) { state.wallets = []; }
}

function saveWallets() {
  const toSave = state.wallets.map(w => ({
    address: w.address,
    chain: w.chain,
    label: w.label || '',
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
}

// ═══════════════════════════════════════════
// CHAIN DETECTION
// ═══════════════════════════════════════════
function detectChain(address) {
  const addr = address.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return 'solana';
  if (/^0x[a-fA-F0-9]{40}$/.test(addr)) return 'evm';
  return null;
}

function shortenAddress(address) {
  if (address.length <= 12) return address;
  if (address.startsWith('0x')) return address.slice(0, 6) + '...' + address.slice(-4);
  return address.slice(0, 4) + '...' + address.slice(-4);
}

// ═══════════════════════════════════════════
// API CALLS (via Cloudflare Worker proxy)
// ═══════════════════════════════════════════
async function fetchPositions(wallet) {
  if (!CONFIG.proxyUrl) throw new Error('No proxy URL configured. Deploy the Cloudflare Worker first.');
  const params = new URLSearchParams({ address: wallet.address });
  const res = await fetch(`${CONFIG.proxyUrl}/positions?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  return data.positions || [];
}

async function fetchNetWorth(wallet) {
  if (!CONFIG.proxyUrl) return { totalUsd: 0, chainBreakdown: {} };
  const params = new URLSearchParams({ address: wallet.address });
  const res = await fetch(`${CONFIG.proxyUrl}/networth?${params}`);
  if (!res.ok) return { totalUsd: 0, chainBreakdown: {} };
  return await res.json();
}

async function fetchBalances(wallet) {
  if (!CONFIG.proxyUrl) return [];
  const params = new URLSearchParams({ address: wallet.address });
  const res = await fetch(`${CONFIG.proxyUrl}/balances?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.balances || [];
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

function fmtPct(val) {
  if (val == null || isNaN(val)) return '';
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
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
    const meta = CONFIG.chainMeta[chain] || { name: chain, icon: '⚪' };
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
  document.getElementById('best-apy').textContent = bestApy > 0 ? fmtPct(bestApy) : '—';
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
    const meta = CONFIG.chainMeta[chain] || { name: chain, icon: '⚪', color: '#888' };
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
        pnlHtml = `<span class="position-pnl ${pnlClass}">PnL ${fmtUsd(totalPnl)}</span>`;
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
    const [posRes, nwRes, balRes] = await Promise.allSettled([
      fetchPositions(wallet),
      fetchNetWorth(wallet),
      fetchBalances(wallet),
    ]);

    wallet.positions = posRes.status === 'fulfilled' ? posRes.value : [];
    wallet.netWorth = nwRes.status === 'fulfilled' ? nwRes.value : null;
    wallet.balances = balRes.status === 'fulfilled' ? balRes.value : [];
    wallet.loading = false;
    wallet.lastUpdated = Date.now();

    if (idx === state.activeWalletIdx) renderPositions();
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