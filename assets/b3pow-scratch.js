/* =========================================================================
 * b3pow-scratch.js -- B3PoW-Scratch v1.1.1 (demo browser port)
 *
 *   Ports b3chain/contrib/miner/b3miner-rtl/ref/b3pow_ref.py to vanilla
 *   ES2020+ browser JS for the public demo at /demo.html. Identical
 *   algorithm, intentionally readable rather than fast.
 *
 *   Normative spec:
 *     https://github.com/b3chain/b3chain/blob/b3chain-main/contrib/miner/b3miner-rtl/SPEC.md
 *
 *   Authoritative Python reference:
 *     https://github.com/b3chain/b3chain/blob/b3chain-main/contrib/miner/b3miner-rtl/ref/b3pow_ref.py
 *
 *   Pool TypeScript port (cousin of this file, shares structure):
 *     https://github.com/b3chain/b3chain/blob/b3chain-main/contrib/testnet/pool/src/lib/b3pow-scratch.ts
 *
 *   IMPORTANT: this is a DEMO port. A production miner uses native C++
 *   or RTL; pure browser JS runs at low-double-digit H/s and is useful
 *   only for explaining the algorithm. Verification cost in the
 *   reference C++ validator is ~ 50 ms / header on a 2026 CPU core.
 *
 *   Dual-mode: when loaded as a classic Web Worker the module installs
 *   an `onmessage` handler (commands: `hash`, `warm`, `clear`). When
 *   loaded as a normal <script> it attaches an API object to
 *   `globalThis.B3PoW`. Either way: zero external dependencies, no CDN
 *   for compute (BLAKE3 primitive is implemented inline below).
 * ========================================================================= */
(function (global) {
  'use strict';

  /* === Locked constants (mirror of SPEC §3) =============================== */
  const SCRATCH_BYTES  = 1 << 20;                  /* 1 MiB                  */
  const LANES          = 8;
  const LANE_BYTES     = SCRATCH_BYTES / LANES;    /* 131072                 */
  const BLOCK_BYTES    = 64;                       /* BLAKE3 block size      */
  const LANE_BLOCKS    = LANE_BYTES / BLOCK_BYTES; /* 2048                   */
  const ITERATIONS     = 2048;
  const INNER_ROUNDS   = 2;
  const BLAKE3_ROUNDS  = 7;
  const SCRATCH_BLOCKS = SCRATCH_BYTES / BLOCK_BYTES; /* 16384               */

  /* BLAKE3 domain-separation flags (SPEC §4). */
  const FLAG_CHUNK_START = 0x01;
  const FLAG_CHUNK_END   = 0x02;
  const FLAG_ROOT        = 0x08;

  /* BLAKE3 IV (first 8 of SHA-256 IV). */
  const IV = Object.freeze([
    0x6a09e667 | 0, 0xbb67ae85 | 0, 0x3c6ef372 | 0, 0xa54ff53a | 0,
    0x510e527f | 0, 0x9b05688c | 0, 0x1f83d9ab | 0, 0x5be0cd19 | 0,
  ]);

  /* BLAKE3 message permutation σ. */
  const BLAKE3_PERM = Object.freeze([
    2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8,
  ]);

  /* wyhash secret table (SPEC §3, v1.1.1 -- F-1 fix: ITER_MUL[7] distinct). */
  const ITER_MUL = Object.freeze([
    0xA0761D6478BD642Fn,
    0xE7037ED1A0B428DBn,
    0x8EBC6AF09C88C6E3n,
    0x589965CC75374CC3n,
    0x1D8E4E27C47D124Fn,
    0xEB44ACCAB455D165n,
    0xC863B19A77C75D70n,
    0x6E5C6F88AA5BDA77n,
  ]);

  /* Lane shuffle: L' = (5L + 1) mod 8 (SPEC §6.5). */
  const LANE_SHUFFLE = Object.freeze([1, 6, 3, 0, 5, 2, 7, 4]);

  const MASK64 = 0xFFFFFFFFFFFFFFFFn;

  /* === Low-level helpers ================================================== */
  function rotr32(x, n) {
    const v = x >>> 0;
    return ((v >>> n) | (v << (32 - n))) >>> 0;
  }
  function rotr64(x, n) {
    const nb = BigInt(n);
    return (((x >> nb) | ((x << (64n - nb)) & MASK64)) & MASK64);
  }
  function add32(a, b, c) {
    const ab = ((a >>> 0) + (b >>> 0)) >>> 0;
    return (c === undefined) ? ab : ((ab + (c >>> 0)) >>> 0);
  }
  function readU32LE(buf, off) {
    return (
      (buf[off]      ) |
      (buf[off + 1] << 8) |
      (buf[off + 2] << 16) |
      (buf[off + 3] << 24)
    ) >>> 0;
  }
  function readU64LE(buf, off) {
    const lo = BigInt(readU32LE(buf, off));
    const hi = BigInt(readU32LE(buf, off + 4));
    return lo | (hi << 32n);
  }
  function writeU32LE(buf, off, w) {
    buf[off]     =  w         & 0xff;
    buf[off + 1] = (w >>>  8) & 0xff;
    buf[off + 2] = (w >>> 16) & 0xff;
    buf[off + 3] = (w >>> 24) & 0xff;
  }
  /* Read a 64-byte BLAKE3 block out of `buf[off..off+len]` as 16 u32-LE
   * words. Zero-pads if len < 64 (BLAKE3 spec: final-block padding). */
  function bytesToBlock(buf, off, len) {
    const out = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
    const lim = (len < 64) ? len : 64;
    for (let i = 0; i < lim; i++) {
      const b = buf[off + i];
      const wi = i >>> 2;
      const sh = (i & 3) << 3;
      out[wi] = (out[wi] | (b << sh)) >>> 0;
    }
    return out;
  }
  function hexToBytes(hex) {
    if (typeof hex !== 'string') throw new TypeError('hexToBytes: expected string');
    let h = hex;
    if (h.length >= 2 && (h[0] === '0' && (h[1] === 'x' || h[1] === 'X'))) h = h.slice(2);
    if (h.length % 2) throw new Error('hexToBytes: odd length');
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) {
      const v = parseInt(h.substr(i * 2, 2), 16);
      if (Number.isNaN(v)) throw new Error('hexToBytes: bad char at offset ' + (i * 2));
      out[i] = v;
    }
    return out;
  }
  function bytesToHex(buf) {
    const HEX = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < buf.length; i++) {
      s += HEX[buf[i] >>> 4] + HEX[buf[i] & 0xf];
    }
    return s;
  }

  /* === BLAKE3 round function (SPEC §4) ==================================== */
  /* G() is the quarter-round (BLAKE3 paper §2.5). Identical to
   * b3pow_ref.py::g and to the pool's TypeScript port. */
  function g(s, a, b, c, d, mx, my) {
    s[a] = add32(s[a], s[b], mx);
    s[d] = rotr32(s[d] ^ s[a], 16);
    s[c] = add32(s[c], s[d]);
    s[b] = rotr32(s[b] ^ s[c], 12);
    s[a] = add32(s[a], s[b], my);
    s[d] = rotr32(s[d] ^ s[a], 8);
    s[c] = add32(s[c], s[d]);
    s[b] = rotr32(s[b] ^ s[c], 7);
  }

  /* round_fn = 4 column G's + 4 diagonal G's (BLAKE3 spec). */
  function roundFn(state, m) {
    g(state, 0, 4,  8, 12, m[0],  m[1]);
    g(state, 1, 5,  9, 13, m[2],  m[3]);
    g(state, 2, 6, 10, 14, m[4],  m[5]);
    g(state, 3, 7, 11, 15, m[6],  m[7]);
    g(state, 0, 5, 10, 15, m[8],  m[9]);
    g(state, 1, 6, 11, 12, m[10], m[11]);
    g(state, 2, 7,  8, 13, m[12], m[13]);
    g(state, 3, 4,  9, 14, m[14], m[15]);
  }

  function permuteMsg(m) {
    const out = new Array(16);
    for (let i = 0; i < 16; i++) out[i] = m[BLAKE3_PERM[i]];
    return out;
  }

  /* Full 7-round BLAKE3 compress. Returns 16 u32 words: the first 8 are
   * the new chaining value, all 16 are the root-output node when ROOT
   * flag is set. Matches `blake3_compress_full` in the Python reference. */
  function compress(cv, block, counterLo, counterHi, blockLen, flags) {
    const state = [
      cv[0], cv[1], cv[2], cv[3],
      cv[4], cv[5], cv[6], cv[7],
      IV[0], IV[1], IV[2], IV[3],
      counterLo >>> 0, counterHi >>> 0,
      blockLen  >>> 0, flags     >>> 0,
    ];
    let m = block.slice();
    for (let r = 0; r < BLAKE3_ROUNDS; r++) {
      roundFn(state, m);
      m = permuteMsg(m);
    }
    const out = new Array(16);
    for (let i = 0; i < 8; i++) out[i]     = (state[i]     ^ state[i + 8]) >>> 0;
    for (let i = 0; i < 8; i++) out[i + 8] = (state[i + 8] ^ cv[i])        >>> 0;
    return out;
  }

  /* Single-chunk BLAKE3 (input ≤ 1024 bytes -- all B3PoW inputs satisfy
   * this: longest input is `serialised_lanes || nonce` = 260 bytes).
   * Output length is configurable for the XOF used by `init_scratchpad`. */
  function blake3(data, outLen) {
    if (outLen === undefined) outLen = 32;
    const len = data.length;
    const numBlocks = (len === 0) ? 1 : Math.ceil(len / 64);
    let cv = IV.slice(0, 8);
    let lastBlock = null, lastLen = 0, lastFlags = 0;

    for (let b = 0; b < numBlocks; b++) {
      const off = b * 64;
      const blkLen = (len - off < 64) ? (len - off < 0 ? 0 : len - off) : 64;
      const block = bytesToBlock(data, off, blkLen);
      const isFirst = (b === 0);
      const isLast  = (b === numBlocks - 1);
      let flags = 0;
      if (isFirst) flags |= FLAG_CHUNK_START;
      if (isLast)  flags |= FLAG_CHUNK_END;

      if (!isLast) {
        /* Internal block: just update the chunk CV, counter is the chunk
         * counter (always 0 for single-chunk inputs). */
        const out = compress(cv, block, 0, 0, 64, flags);
        cv = out.slice(0, 8);
      } else {
        /* Final block of the chunk = root output node. Defer compression
         * to the output loop so we can extend with output_counter. */
        lastBlock = block;
        lastLen   = blkLen;
        lastFlags = flags | FLAG_ROOT;
      }
    }

    /* Root output: compress with incrementing output_counter to produce
     * 64 bytes per call. For outLen=32 we only do 1 call; init_scratchpad
     * needs 64 bytes also = 1 call. Larger outputs would need more. */
    const out = new Uint8Array(outLen);
    let pos = 0;
    let outCounter = 0;
    while (pos < outLen) {
      const state = compress(cv, lastBlock, outCounter, 0, lastLen, lastFlags);
      for (let i = 0; i < 16 && pos < outLen; i++) {
        const w = state[i] >>> 0;
        for (let j = 0; j < 4 && pos < outLen; j++) {
          out[pos++] = (w >>> (j << 3)) & 0xff;
        }
      }
      outCounter = (outCounter + 1) >>> 0;
    }
    return out;
  }

  /* Reduced-round BLAKE3 compress used by the mixing core (SPEC §6.5).
   * Runs `innerRounds` rounds (vs 7 for full BLAKE3) and returns
   * (new_cv_words, permuted_msg). */
  function blake3ShortCompress(cv, block, innerRounds) {
    if (innerRounds === undefined) innerRounds = INNER_ROUNDS;
    const state = [
      cv[0], cv[1], cv[2], cv[3],
      cv[4], cv[5], cv[6], cv[7],
      IV[0], IV[1], IV[2], IV[3],
      0, 0, BLOCK_BYTES, 0,
    ];
    let m = block.slice();
    for (let r = 0; r < innerRounds; r++) {
      roundFn(state, m);
      m = permuteMsg(m);
    }
    const newCv = new Array(8);
    for (let i = 0; i < 8; i++) newCv[i] = (state[i] ^ state[i + 8]) >>> 0;
    return { newCv: newCv, permutedMsg: m };
  }

  /* === Top-level B3PoW-Scratch v1.1.1 (SPEC §5) ============================ */

  /* SPEC §6.1: pad[i*64..(i+1)*64] = BLAKE3-XOF(prev_block_hash || u32_le(i), 64). */
  function initScratchpad(prevBlockHashLE) {
    if (prevBlockHashLE.length !== 32) throw new Error('prevBlockHashLE must be 32 bytes');
    const pad = new Uint8Array(SCRATCH_BYTES);
    const seedBuf = new Uint8Array(36);
    seedBuf.set(prevBlockHashLE, 0);
    for (let i = 0; i < SCRATCH_BLOCKS; i++) {
      seedBuf[32] =  i         & 0xff;
      seedBuf[33] = (i >>>  8) & 0xff;
      seedBuf[34] = (i >>> 16) & 0xff;
      seedBuf[35] = (i >>> 24) & 0xff;
      const chunk = blake3(seedBuf, BLOCK_BYTES);
      pad.set(chunk, i * BLOCK_BYTES);
    }
    return pad;
  }

  /* SPEC §6.2: lanes[L] = BLAKE3(seed || u32_le(L)).digest(). */
  function initLanes(seed) {
    if (seed.length !== 32) throw new Error('seed must be 32 bytes');
    const tmp = new Uint8Array(36);
    tmp.set(seed, 0);
    const out = new Array(LANES);
    for (let L = 0; L < LANES; L++) {
      tmp[32] =  L         & 0xff;
      tmp[33] = (L >>>  8) & 0xff;
      tmp[34] = (L >>> 16) & 0xff;
      tmp[35] = (L >>> 24) & 0xff;
      out[L] = blake3(tmp, 32);
    }
    return out;
  }

  /* SPEC §6.3: per-lane scratchpad block address.
   *   mul64 = ((hi XOR iter) * ITER_MUL[L]) mod 2^64
   *   mixed = lo XOR rotr64(mul64, 23)
   *   addr  = mixed mod LANE_BLOCKS                  */
  function deriveAddresses(lanes, iterIdx) {
    const mask = BigInt(LANE_BLOCKS - 1);
    const itr  = BigInt(iterIdx >>> 0);
    const addrs = new Array(LANES);
    for (let L = 0; L < LANES; L++) {
      const lo = readU64LE(lanes[L], 0);
      const hi = readU64LE(lanes[L], 8);
      const mul = ((hi ^ itr) * ITER_MUL[L]) & MASK64;
      const mixed = lo ^ rotr64(mul, 23);
      addrs[L] = Number(mixed & mask);
    }
    return addrs;
  }

  /* SPEC §5: top-level PoW.
   *
   *   @param header           Uint8Array(80) -- block header.
   *   @param prevBlockHashLE  Uint8Array(32) -- raw LE prev_block_hash
   *                           (bytes 4..36 of header).
   *   @param pad              Optional pre-built pad. MUTATED in place.
   *   @param onProgress       Optional fn(done, total) called every 128
   *                           iterations -- the worker uses this to push
   *                           progress to the UI.
   *   @returns                { powHash: Uint8Array(32), iterations,
   *                             pad: Uint8Array(SCRATCH_BYTES) }
   */
  function b3powScratch(header, prevBlockHashLE, pad, onProgress) {
    if (header.length !== 80) throw new Error('header must be 80 bytes');
    if (prevBlockHashLE.length !== 32) throw new Error('prevBlockHashLE must be 32 bytes');

    const nonce = header.subarray(76, 80);
    const seed  = blake3(header, 32);

    const padBuf = pad || initScratchpad(prevBlockHashLE);
    if (padBuf.length !== SCRATCH_BYTES) {
      throw new Error('pad must be ' + SCRATCH_BYTES + ' bytes, got ' + padBuf.length);
    }

    let lanes = initLanes(seed);
    /* Scratch buffers reused across iterations to keep GC pressure down. */
    const block = new Uint8Array(BLOCK_BYTES);
    const wb    = new Uint8Array(BLOCK_BYTES);

    for (let r = 0; r < ITERATIONS; r++) {
      const addrs = deriveAddresses(lanes, r);
      const newLanes = new Array(LANES);

      for (let L = 0; L < LANES; L++) {
        const base = L * LANE_BYTES + addrs[L] * BLOCK_BYTES;

        /* parallel_read (SPEC §6.4) */
        for (let i = 0; i < BLOCK_BYTES; i++) block[i] = padBuf[base + i];

        /* mix (SPEC §6.5) */
        const cv = new Array(8);
        for (let i = 0; i < 8; i++) cv[i] = readU32LE(lanes[L], i * 4);
        const msg = new Array(16);
        for (let i = 0; i < 16; i++) msg[i] = readU32LE(block, i * 4);
        const mix = blake3ShortCompress(cv, msg);

        const newLane = new Uint8Array(32);
        for (let i = 0; i < 8; i++) writeU32LE(newLane, i * 4, mix.newCv[i]);
        newLanes[L] = newLane;

        /* writeback = block XOR serialised(permuted_msg) (SPEC §6.6) */
        for (let i = 0; i < 16; i++) {
          const w = mix.permutedMsg[i] >>> 0;
          wb[i * 4]     = block[i * 4]     ^ ( w         & 0xff);
          wb[i * 4 + 1] = block[i * 4 + 1] ^ ((w >>>  8) & 0xff);
          wb[i * 4 + 2] = block[i * 4 + 2] ^ ((w >>> 16) & 0xff);
          wb[i * 4 + 3] = block[i * 4 + 3] ^ ((w >>> 24) & 0xff);
        }
        /* parallel_write (SPEC §6.6) */
        for (let i = 0; i < BLOCK_BYTES; i++) padBuf[base + i] = wb[i];
      }

      /* lane_shuffle (SPEC §6.5) -- cross-lane diffusion. */
      const shuffled = new Array(LANES);
      for (let L = 0; L < LANES; L++) shuffled[L] = newLanes[LANE_SHUFFLE[L]];
      lanes = shuffled;

      if (onProgress && (r & 0x7f) === 0x7f) onProgress(r + 1, ITERATIONS);
    }

    /* final hash (SPEC §6.7) */
    const tail = new Uint8Array(LANES * 32 + 4);
    for (let L = 0; L < LANES; L++) tail.set(lanes[L], L * 32);
    tail.set(nonce, LANES * 32);
    const powHash = blake3(tail, 32);
    return { powHash: powHash, iterations: ITERATIONS, pad: padBuf };
  }

  /* SPEC §7: nbits-compact decode (Bitcoin layout, unchanged). */
  function nbitsToTarget(nbits) {
    const size = (nbits >>> 24) & 0xff;
    const word = BigInt(nbits & 0x007fffff);
    if (size <= 3) return word >> BigInt(8 * (3 - size));
    return word << BigInt(8 * (size - 3));
  }
  function intLE(buf) {
    if (buf.length !== 32) throw new Error('intLE: expected 32 bytes');
    let acc = 0n;
    for (let i = 31; i >= 0; i--) acc = (acc << 8n) | BigInt(buf[i]);
    return acc;
  }

  /* === Public API ========================================================= */
  const API = Object.freeze({
    /* constants */
    SCRATCH_BYTES: SCRATCH_BYTES,
    LANES: LANES,
    LANE_BYTES: LANE_BYTES,
    BLOCK_BYTES: BLOCK_BYTES,
    LANE_BLOCKS: LANE_BLOCKS,
    ITERATIONS: ITERATIONS,
    INNER_ROUNDS: INNER_ROUNDS,
    BLAKE3_ROUNDS: BLAKE3_ROUNDS,
    SCRATCH_BLOCKS: SCRATCH_BLOCKS,
    IV: IV,
    BLAKE3_PERM: BLAKE3_PERM,
    ITER_MUL: ITER_MUL,
    LANE_SHUFFLE: LANE_SHUFFLE,
    FLAG_CHUNK_START: FLAG_CHUNK_START,
    FLAG_CHUNK_END: FLAG_CHUNK_END,
    FLAG_ROOT: FLAG_ROOT,
    /* BLAKE3 primitives */
    g: g,
    roundFn: roundFn,
    permuteMsg: permuteMsg,
    compress: compress,
    blake3: blake3,
    blake3ShortCompress: blake3ShortCompress,
    /* B3PoW */
    initScratchpad: initScratchpad,
    initLanes: initLanes,
    deriveAddresses: deriveAddresses,
    b3powScratch: b3powScratch,
    nbitsToTarget: nbitsToTarget,
    intLE: intLE,
    /* utilities */
    hexToBytes: hexToBytes,
    bytesToHex: bytesToHex,
    rotr32: rotr32,
    rotr64: rotr64,
    readU32LE: readU32LE,
    readU64LE: readU64LE,
    writeU32LE: writeU32LE,
  });

  /* === Worker harness =====================================================
   * When loaded as a classic Web Worker (`new Worker(url)`), set up the
   * message protocol. When loaded as a normal script, attach API to
   * the global. */
  const isWorker =
    (typeof importScripts === 'function') &&
    (typeof postMessage === 'function') &&
    (typeof window === 'undefined');

  if (isWorker) {
    /* Pad cache: prev_block_hash_hex -> pristine pad. b3powScratch
     * mutates its pad argument, so we always hand out a fresh copy. */
    const padCache = new Map();

    function getPad(prevHex) {
      if (padCache.has(prevHex)) {
        return new Uint8Array(padCache.get(prevHex));
      }
      const fresh = initScratchpad(hexToBytes(prevHex));
      padCache.set(prevHex, new Uint8Array(fresh));
      return fresh;
    }
    function now() {
      return (typeof performance !== 'undefined') ? performance.now() : Date.now();
    }

    global.onmessage = function (e) {
      const msg = (e && e.data) || {};
      const id  = msg.id;
      try {
        if (msg.cmd === 'hash') {
          const header  = hexToBytes(msg.headerHex);
          const prev    = hexToBytes(msg.prevHex);
          const cached  = padCache.has(msg.prevHex);
          const t0      = now();
          const pad     = getPad(msg.prevHex);
          const tInit   = now();
          const result  = b3powScratch(header, prev, pad, function (done, total) {
            global.postMessage({ id: id, type: 'progress', done: done, total: total });
          });
          const t1      = now();
          global.postMessage({
            id: id, type: 'result', ok: true,
            hashHex: bytesToHex(result.powHash),
            cached: cached,
            initMs: tInit - t0,
            mixMs:  t1    - tInit,
            totalMs: t1   - t0,
          });
        } else if (msg.cmd === 'warm') {
          const t0 = now();
          getPad(msg.prevHex);
          const t1 = now();
          global.postMessage({ id: id, type: 'warm', ok: true, ms: t1 - t0 });
        } else if (msg.cmd === 'clear') {
          padCache.clear();
          global.postMessage({ id: id, type: 'clear', ok: true });
        } else {
          throw new Error('unknown cmd: ' + msg.cmd);
        }
      } catch (err) {
        global.postMessage({
          id: id, type: 'error', ok: false,
          error: String((err && err.message) || err),
        });
      }
    };
  } else {
    global.B3PoW = API;
  }
})(typeof self !== 'undefined'
   ? self
   : (typeof globalThis !== 'undefined' ? globalThis : this));
