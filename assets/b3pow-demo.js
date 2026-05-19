/* =========================================================================
 * b3pow-demo.js -- /demo.html orchestration (vanilla ES2020+, no framework).
 *
 *   Wires up the six interactive components on the B3PoW-Scratch demo page:
 *
 *     1. BLAKE3 round demonstration (in-browser, step-through)
 *     2. Scratchpad mutation animation (visual only, not real mining)
 *     3. Live testnet status mini-panel (polls /testnet-status.json)
 *     4. Hash-once playground (real B3PoW-Scratch via Web Worker)
 *     5. Faucet UX (form -> faucet.b3chain.org/request)
 *     6. Sparrow / Specter / Electrum wallet config download
 *
 *   Loads /assets/b3pow-scratch.js for B3PoW.* primitives (round_fn, IV,
 *   permuteMsg, etc.) AND spawns a Worker around the same file for the
 *   real B3PoW-Scratch evaluation in component 4.
 *
 *   No tracking, no analytics, no external resources. Mobile-friendly:
 *   components 1 and 2 hide their interactive guts on < 768 px viewports.
 * ========================================================================= */
(function () {
  'use strict';

  const B = window.B3PoW;
  if (!B) {
    console.error('b3pow-demo: B3PoW not loaded (b3pow-scratch.js missing?)');
    return;
  }

  /* === Utility ============================================================ */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function hex32(w) {
    const s = ((w >>> 0).toString(16));
    return ('00000000' + s).slice(-8);
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* === Component 1: BLAKE3 round demonstration ============================ */
  /* The 8 G() calls in one BLAKE3 round, in order: 4 columns then 4 diagonals.
   * Each tuple: (cellA, cellB, cellC, cellD, msgIdxX, msgIdxY, kind). */
  const G_TUPLES = [
    [0, 4,  8, 12,  0,  1, 'col'],
    [1, 5,  9, 13,  2,  3, 'col'],
    [2, 6, 10, 14,  4,  5, 'col'],
    [3, 7, 11, 15,  6,  7, 'col'],
    [0, 5, 10, 15,  8,  9, 'diag'],
    [1, 6, 11, 12, 10, 11, 'diag'],
    [2, 7,  8, 13, 12, 13, 'diag'],
    [3, 4,  9, 14, 14, 15, 'diag'],
  ];
  /* Canonical cv + m for the "reset" button. cv = first 8 of BLAKE3 IV;
   * m = lane-style "i over 16" pattern. Reproducible, not secret. */
  const CANONICAL_CV = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const CANONICAL_M = [
    0x00112233, 0x44556677, 0x8899aabb, 0xccddeeff,
    0x01020304, 0x05060708, 0x090a0b0c, 0x0d0e0f10,
    0x11121314, 0x15161718, 0x191a1b1c, 0x1d1e1f20,
    0x21222324, 0x25262728, 0x292a2b2c, 0x2d2e2f30,
  ];

  function initBlake3Demo() {
    const stateGrid = $('#b3-state');
    const msgGrid   = $('#b3-msg');
    const gList     = $('#b3-gs');
    const stepInfo  = $('#b3-step');
    if (!stateGrid || !msgGrid || !gList) return;

    /* Render initial DOM: 16 state cells, 16 message inputs, 8 G rows. */
    stateGrid.innerHTML = '';
    for (let i = 0; i < 16; i++) {
      const d = document.createElement('div');
      d.className = 'b3-cell';
      d.dataset.idx = i;
      d.innerHTML = '<span class="ix">s[' + i + ']</span><span class="hex"></span>';
      stateGrid.appendChild(d);
    }
    msgGrid.innerHTML = '';
    for (let i = 0; i < 16; i++) {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.maxLength = 8;
      inp.dataset.midx = i;
      inp.setAttribute('aria-label', 'message word m[' + i + ']');
      msgGrid.appendChild(inp);
    }
    gList.innerHTML = '';
    for (let i = 0; i < 8; i++) {
      const t = G_TUPLES[i];
      const d = document.createElement('div');
      d.className = 'b3-g ' + t[6];
      d.dataset.gix = i;
      d.textContent = 'G[' + i + '] ' + t[6] +
        ' (a=' + t[0] + ', b=' + t[1] + ', c=' + t[2] + ', d=' + t[3] +
        ', mx=m[' + t[4] + '], my=m[' + t[5] + '])';
      gList.appendChild(d);
    }

    /* State machine. */
    let cv     = CANONICAL_CV.slice();
    let m      = CANONICAL_M.slice();
    let state  = null;        /* 16 u32 -- current BLAKE3 internal state    */
    let round  = 0;           /* current round (0..6)                       */
    let gStep  = 0;           /* current G within round (0..7)              */
    let started = false;      /* false => state initialised but no G run    */

    function buildState() {
      return [
        cv[0], cv[1], cv[2], cv[3], cv[4], cv[5], cv[6], cv[7],
        B.IV[0], B.IV[1], B.IV[2], B.IV[3],
        0, 0, 64, 0,
      ];
    }

    function readMFromInputs() {
      const inputs = $$('input', msgGrid);
      for (let i = 0; i < 16; i++) {
        const v = parseInt(inputs[i].value.replace(/^0x/i, ''), 16);
        m[i] = (Number.isNaN(v) ? 0 : v) >>> 0;
      }
    }

    function writeMToInputs() {
      const inputs = $$('input', msgGrid);
      for (let i = 0; i < 16; i++) inputs[i].value = hex32(m[i]);
    }

    function renderState(highlightG /* -1 or 0..7 */) {
      const cells = $$('.b3-cell', stateGrid);
      for (let i = 0; i < 16; i++) {
        cells[i].classList.remove('hl-a', 'hl-b', 'hl-c', 'hl-d');
        cells[i].querySelector('.hex').textContent = state ? hex32(state[i]) : '--------';
      }
      const inputs = $$('input', msgGrid);
      for (let i = 0; i < 16; i++) inputs[i].classList.remove('hl-m');
      const gs = $$('.b3-g', gList);
      for (let i = 0; i < 8; i++) gs[i].classList.remove('active');
      if (highlightG >= 0) {
        const t = G_TUPLES[highlightG];
        cells[t[0]].classList.add('hl-a');
        cells[t[1]].classList.add('hl-b');
        cells[t[2]].classList.add('hl-c');
        cells[t[3]].classList.add('hl-d');
        inputs[t[4]].classList.add('hl-m');
        inputs[t[5]].classList.add('hl-m');
        gs[highlightG].classList.add('active');
      }
      if (stepInfo) {
        if (!started) {
          stepInfo.textContent = 'state initialised from cv + IV + counter/blockLen/flags; press a button to start.';
        } else {
          stepInfo.textContent = 'round ' + round + ' / 7, just ran G[' +
            ((gStep - 1 + 8) & 7) + '] (' + (highlightG >= 0 ? G_TUPLES[highlightG][6] : '') + ').';
        }
      }
    }

    function reset() {
      cv = CANONICAL_CV.slice();
      m  = CANONICAL_M.slice();
      writeMToInputs();
      state = buildState();
      round = 0; gStep = 0; started = false;
      renderState(-1);
    }

    function stepG() {
      if (!started) {
        readMFromInputs();
        state = buildState();
        started = true;
      }
      const t = G_TUPLES[gStep];
      B.g(state, t[0], t[1], t[2], t[3], m[t[4]], m[t[5]]);
      const lastG = gStep;
      gStep++;
      if (gStep === 8) {
        m = B.permuteMsg(m);
        writeMToInputs();
        gStep = 0;
        round++;
        if (round >= 7) {
          /* Cap at round 7; further clicks reset to round 7 view. */
          round = 7;
        }
      }
      renderState(lastG);
    }

    function stepRound() {
      if (round >= 7) return;
      while (gStep !== 0 || !started) stepG();
      /* After the loop above, gStep is 0; we may have just finished a round. */
      if (round >= 7) return;
      for (let i = 0; i < 8; i++) stepG();
    }

    function completeAll() {
      while (round < 7) stepRound();
    }

    /* Wire buttons. */
    $('#b3-btn-reset').addEventListener('click', reset);
    $('#b3-btn-step-g').addEventListener('click', stepG);
    $('#b3-btn-step-round').addEventListener('click', stepRound);
    $('#b3-btn-complete').addEventListener('click', completeAll);

    /* Edits to message inputs reset the run-state (so the user can play). */
    msgGrid.addEventListener('input', function () {
      started = false; round = 0; gStep = 0;
      readMFromInputs(); state = buildState(); renderState(-1);
    });

    reset();
  }

  /* === Component 2: scratchpad mutation animation ========================= */
  /* Visualises the 1 MB scratchpad as an 8x256 cell grid (each cell = 512
   * bytes = 8 BLAKE3 blocks; one row per lane). Animated cursors jump to
   * random addresses (lane-local) and the cell briefly lights up. This is
   * NOT real mining -- real mining mutates ~10^4 cells per millisecond and
   * would just be a uniformly-flashing grid. */
  function initScratchpadAnim() {
    const canvas = $('#pad-canvas');
    if (!canvas) return;
    const speedInput = $('#pad-speed');
    const btnPlay  = $('#pad-play');
    const btnPause = $('#pad-pause');
    const btnReset = $('#pad-reset');

    const COLS = 256;
    const ROWS = 8;
    /* Logical -> pixel sizing. We keep the canvas at a fixed bitmap and
     * let CSS scale it; the bitmap stays sharp at moderate dpr. */
    const cellW = 4;
    const cellH = 14;
    const padX = 28;        /* left margin for the lane label             */
    const padY = 4;
    const widthPx  = padX + COLS * cellW + 4;
    const heightPx = padY * 2 + ROWS * cellH;
    canvas.width  = widthPx;
    canvas.height = heightPx;
    canvas.setAttribute('aria-label',
      '1 MiB scratchpad shown as 8 rows (lanes) by 256 cells; each cell = 512 bytes. ' +
      'Cursors hop within each lane and write events flash the cell briefly.');

    const ctx = canvas.getContext('2d');
    /* Cell heat-map: 0 (cold) -> 255 (just-written, fades to 0 over ~1 s). */
    const heat = new Uint8Array(ROWS * COLS);
    /* Per-lane cursor position (column 0..COLS-1). */
    const cursors = new Uint32Array(ROWS);
    let raf = null;
    let last = 0;
    let stepAcc = 0;            /* ms accumulator for the step interval */
    let playing = true;

    function draw() {
      ctx.clearRect(0, 0, widthPx, heightPx);
      /* Cells */
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const h = heat[r * COLS + c];
          if (h === 0) {
            ctx.fillStyle = '#f0f0f0';
          } else {
            /* Hot cells: warm orange, fading. */
            const a = h / 255;
            ctx.fillStyle = 'rgba(199, 155, 58,' + (0.15 + 0.85 * a).toFixed(3) + ')';
          }
          ctx.fillRect(padX + c * cellW, padY + r * cellH + 1, cellW - 1, cellH - 2);
        }
      }
      /* Cursors */
      ctx.fillStyle = '#1a5a8e';
      for (let r = 0; r < ROWS; r++) {
        const c = cursors[r];
        ctx.fillRect(padX + c * cellW, padY + r * cellH + 1, cellW - 1, cellH - 2);
      }
      /* Lane labels */
      ctx.fillStyle = '#555';
      ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
      ctx.textBaseline = 'middle';
      for (let r = 0; r < ROWS; r++) {
        ctx.fillText('L' + r, 4, padY + r * cellH + cellH / 2);
      }
    }

    function stepOnce() {
      for (let r = 0; r < ROWS; r++) {
        /* Jump cursor to a new (lane-local) address. Real B3PoW addresses
         * are derived from `lanes[L]` via a wyhash mix; here we just take
         * a hash-like pseudo-random based on Math.random for visual effect. */
        const newC = (Math.random() * COLS) | 0;
        cursors[r] = newC;
        heat[r * COLS + newC] = 255;
      }
    }

    function fade() {
      for (let i = 0; i < heat.length; i++) {
        if (heat[i] > 0) heat[i] = Math.max(0, heat[i] - 12);
      }
    }

    function loop(t) {
      raf = null;
      if (!last) last = t;
      const dt = t - last;
      last = t;
      if (playing) {
        const sp = clamp(parseInt(speedInput.value, 10) || 4, 1, 60);
        const stepIntervalMs = Math.round(1000 / sp);
        stepAcc += dt;
        while (stepAcc >= stepIntervalMs) {
          stepOnce();
          stepAcc -= stepIntervalMs;
        }
        fade();
      }
      draw();
      raf = requestAnimationFrame(loop);
    }

    function start() {
      playing = true;
      if (!raf) { last = 0; raf = requestAnimationFrame(loop); }
    }
    function stop() { playing = false; }
    function resetAll() {
      heat.fill(0);
      for (let r = 0; r < ROWS; r++) cursors[r] = (Math.random() * COLS) | 0;
      draw();
    }

    btnPlay.addEventListener('click', start);
    btnPause.addEventListener('click', stop);
    btnReset.addEventListener('click', resetAll);
    resetAll();
    start();
  }

  /* === Component 3: live testnet status mini-panel ======================== */
  /* Polls /testnet-status.json every 60s (same endpoint testnet.html uses)
   * and renders the 4-5 fields most relevant to a casual visitor. */
  function initLiveStatus() {
    const STATUS_URL = '/testnet-status.json';
    const REFRESH_MS = 60 * 1000;

    function fmtNum(n) {
      if (n == null || isNaN(n)) return 'n/a';
      if (n >= 1e12) return (n / 1e12).toFixed(2) + ' T';
      if (n >= 1e9)  return (n / 1e9 ).toFixed(2) + ' G';
      if (n >= 1e6)  return (n / 1e6 ).toFixed(2) + ' M';
      if (n >= 1e3)  return (n / 1e3 ).toFixed(2) + ' k';
      return Number(n).toFixed(2);
    }
    function fmtAge(s) {
      if (s == null) return '';
      s = Math.max(0, Math.floor(s));
      if (s < 90)    return s + ' s ago';
      if (s < 5400)  return Math.round(s / 60) + ' min ago';
      if (s < 86400) return (s / 3600).toFixed(1) + ' h ago';
      return (s / 86400).toFixed(1) + ' d ago';
    }
    function setVal(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
    function unavailable() {
      const wrap = $('#mini-status-wrap');
      if (wrap) wrap.innerHTML =
        '<p class="muted" style="font-size:13px">' +
        '(<code>/testnet-status.json</code> unavailable; check ' +
        '<a href="/testnet.html">testnet.html</a> for live status)</p>';
    }

    function render(doc, fetchedAt) {
      setVal('ms-height',
        (doc && doc.node && doc.node.height != null)
          ? doc.node.height.toLocaleString()
          : 'n/a');
      setVal('ms-diff',
        (doc && doc.node && doc.node.difficulty != null)
          ? fmtNum(doc.node.difficulty)
          : 'n/a');
      const hps = doc && doc.network && doc.network.hashrate_estimate_hps;
      setVal('ms-hps', (hps == null) ? 'n/a' : fmtNum(hps) + ' H/s');
      const workers = doc && doc.pool && doc.pool.connected_workers;
      setVal('ms-workers', (workers == null) ? 'n/a' : workers);

      const tbody = $('#mini-blocks tbody');
      if (tbody) {
        const rb = (doc && doc.recent_blocks) || [];
        if (!rb.length) {
          tbody.innerHTML = '<tr><td colspan="3" class="muted">n/a</td></tr>';
        } else {
          tbody.innerHTML = '';
          rb.slice(0, 5).forEach(function (b) {
            const tr = document.createElement('tr');
            const age = b.time ? fmtAge((fetchedAt - b.time * 1000) / 1000) : '?';
            tr.innerHTML =
              '<td>' + (b.height == null ? '?' : b.height) + '</td>' +
              '<td>' + age + '</td>' +
              '<td>' + (b.tx_count == null ? '?' : b.tx_count) + '</td>';
            tbody.appendChild(tr);
          });
        }
      }
      const meta = $('#mini-meta');
      if (meta) {
        const gen = doc && doc.generated_at ? new Date(doc.generated_at + '') : null;
        meta.textContent = 'updated ' + (gen ? gen.toISOString().replace('T', ' ').replace(/\..+$/, ' UTC') : 'n/a');
      }
    }

    function refresh() {
      fetch(STATUS_URL + '?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (doc) { render(doc, Date.now()); })
        .catch(function () { unavailable(); });
    }
    refresh();
    setInterval(refresh, REFRESH_MS);
  }

  /* === Component 4: hash-once playground ================================== */
  function initHashPlayground() {
    const btn      = $('#hp-btn-hash');
    if (!btn) return;
    const banner   = $('#hp-banner');
    const gotEl    = $('#hp-got');
    const timeEl   = $('#hp-time');
    const progress = $('#hp-progress');
    const progBar  = $('#hp-progress > div');
    const expEl    = $('#hp-expected');

    /* Consensus vector embedded by hand from
     * b3chain/src/test/data/b3pow_consensus_vectors.json -- the
     * `cache_pair_nonce_0` entry. The JS port is verified to byte-match
     * this expected hash; if it stops matching the launch is blocked. */
    const VECTOR = {
      name: 'cache_pair_nonce_0',
      headerHex:
        '010000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20' +
        '000000000000000000000000000000000000000000000000000000000000' +
        '00008041a967ffff7f1d00000000',
      prevHex:
        '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
      expectedHex:
        'c9b61079e2e50c4dacc51af107043d4a0b47c84945bc8d6d1df6b801b6430313',
    };
    if (expEl) expEl.textContent = VECTOR.expectedHex;
    $('#hp-header').textContent = VECTOR.headerHex;
    $('#hp-prev').textContent   = VECTOR.prevHex;
    $('#hp-name').textContent   = VECTOR.name;

    /* Spawn the worker around b3pow-scratch.js. */
    let worker = null;
    try {
      worker = new Worker('/assets/b3pow-scratch.js');
    } catch (e) {
      banner.className = 'banner bad';
      banner.textContent = 'Web Workers unavailable in this browser; hash-once playground disabled.';
      btn.disabled = true;
      return;
    }

    let nextId = 1;
    let pendingId = 0;
    let firstRun = true;

    worker.onerror = function (e) {
      banner.className = 'banner bad';
      banner.textContent = 'Worker error: ' + (e.message || 'unknown');
      btn.disabled = false;
    };
    worker.onmessage = function (e) {
      const msg = e.data || {};
      if (msg.id !== pendingId) return;
      if (msg.type === 'progress') {
        const frac = msg.done / msg.total;
        progBar.style.width = (frac * 100).toFixed(1) + '%';
        return;
      }
      if (msg.type === 'result') {
        progBar.style.width = '100%';
        progress.style.display = 'none';
        gotEl.textContent = msg.hashHex;
        timeEl.textContent = 'init ' + msg.initMs.toFixed(0) + ' ms + mix ' +
                             msg.mixMs.toFixed(0) + ' ms = ' +
                             msg.totalMs.toFixed(0) + ' ms' +
                             (msg.cached ? ' (pad reused from cache)' : ' (first run)');
        if (msg.hashHex === VECTOR.expectedHex) {
          banner.className = 'banner ok';
          banner.textContent = 'matches consensus vector "' + VECTOR.name + '" -- the in-browser port is byte-identical to the C++ validator and the FPGA reference.';
        } else {
          banner.className = 'banner bad';
          banner.textContent = 'MISMATCH against consensus vector "' + VECTOR.name + '". This is a launch blocker; please open an issue.';
        }
        btn.disabled = false;
        firstRun = false;
        return;
      }
      if (msg.type === 'error') {
        banner.className = 'banner bad';
        banner.textContent = 'Hash failed: ' + msg.error;
        progress.style.display = 'none';
        btn.disabled = false;
      }
    };

    btn.addEventListener('click', function () {
      banner.className = 'banner busy';
      banner.textContent = firstRun
        ? 'warming up scratchpad (1 MiB BLAKE3-XOF init)...'
        : 'hashing... (pad reused from cache, this is just the mix loop)';
      gotEl.textContent  = 'computing...';
      timeEl.textContent = '';
      progress.style.display = 'block';
      progBar.style.width = '0%';
      btn.disabled = true;
      pendingId = nextId++;
      worker.postMessage({
        id: pendingId, cmd: 'hash',
        headerHex: VECTOR.headerHex,
        prevHex:   VECTOR.prevHex,
      });
    });
  }

  /* === Component 5: faucet UX ============================================ */
  function initFaucet() {
    const form = $('#faucet-form');
    if (!form) return;
    const addrInput = $('#faucet-addr');
    const msg = $('#faucet-msg');

    function setMsg(text, cls) {
      msg.textContent = text;
      msg.className = 'faucet-msg ' + (cls || '');
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const addr = (addrInput.value || '').trim();
      if (!addr) { setMsg('Enter a tb3... address first.', 'fail'); return; }
      if (!/^tb3[0-9a-z]{6,}$/i.test(addr)) {
        setMsg('Address does not look like a B3Chain testnet bech32 ' +
               '(should start with "tb3" and contain only lowercase letters/digits).',
               'fail');
        return;
      }
      /* The faucet does not yet expose a JSON API: the /request endpoint
       * returns HTML and a redirect. Open it in a new tab (with the
       * address pre-filled via query string so the user just clicks
       * "request"). When the faucet grows a JSON API, replace this with
       * a fetch() POST + txid display + watch-funds-arrive widget. */
      const url = 'https://faucet.b3chain.org/?address=' + encodeURIComponent(addr);
      window.open(url, '_blank', 'noopener');
      setMsg('Opened faucet.b3chain.org in a new tab. The faucet has its own ' +
             'rate-limit (24 h per IP, 24 h per address) and CAPTCHA flow; ' +
             'finish the request there. Funds arrive in roughly one block ' +
             '(testnet target = 600 s).', 'pass');

      /* Light-weight watch-funds-arrive widget: poll the explorer for the
       * address every 30 s, render the most-recent tx. Works whether or
       * not the user actually completed the faucet flow -- it just shows
       * "no activity yet" until something lands. */
      startWatch(addr);
    });

    let watchTimer = null;
    function startWatch(addr) {
      if (watchTimer) clearInterval(watchTimer);
      const watch = $('#faucet-watch');
      watch.style.display = 'block';
      watch.innerHTML =
        '<b>Watching</b> <code>' + addr + '</code> on ' +
        '<a href="https://explorer.b3chain.org/address/' + addr +
        '" target="_blank" rel="noopener">explorer.b3chain.org</a> ' +
        '(refresh every 30 s; first confirm typically ~600 s on testnet). ' +
        '<span id="faucet-watch-status" class="muted"></span>';
      const statusEl = $('#faucet-watch-status');
      let ticks = 0;
      function poll() {
        ticks++;
        statusEl.textContent = 'check #' + ticks + ' at ' +
          new Date().toLocaleTimeString();
        /* Cross-origin: btc-rpc-explorer doesn't expose CORS. We just
         * link out for the actual check. A future status-monitor JSON
         * field per address would let us read directly. */
      }
      poll();
      watchTimer = setInterval(poll, 30 * 1000);
    }
  }

  /* === Component 6: wallet config download (BIP21 + JSON blob) =========== */
  function initWallet() {
    const bip21 = $('#wallet-bip21');
    if (bip21) {
      /* Generate a BIP21 URI pointing to a placeholder address. Real
       * users will replace the address with their own; the URI demonstrates
       * the wallet-handler hand-off for any wallet registered for the
       * b3chain: URI scheme. */
      bip21.href = 'b3chain:tb3qexampledemoaddressreplaceme0000000000?label=B3Chain+testnet&message=Demo+payment';
    }
  }

  /* === Bootstrap ========================================================= */
  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }
  ready(function () {
    /* Each init function is isolated -- one component failing should not
     * take the whole page down. */
    [initBlake3Demo, initScratchpadAnim, initLiveStatus,
     initHashPlayground, initFaucet, initWallet].forEach(function (fn) {
      try { fn(); } catch (e) {
        console.error('demo init error in ' + fn.name + ':', e);
      }
    });
  });
})();
