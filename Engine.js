// Engine.js — orchestrator; preserves v118 behavior byte-for-byte on state
const readline = require('readline');
const crypto = require('crypto');
const WorldGen = require('./WorldGen');
const Actions = require('./ActionProcessor');

// === Routing Adapters ===
function generateWorldFromDescriptionAdapter(state, description) {
  console.log('[Engine] World prompt:', String(description).substring(0, 50));
  if (WorldGen && typeof WorldGen.generateWorldFromDescription === 'function') {
    return WorldGen.generateWorldFromDescription(state, String(description));
  }
  if (WorldGen && typeof WorldGen.initWorld === 'function') {
    return WorldGen.initWorld(state, String(description));
  }
  if (WorldGen && typeof WorldGen.ensureWorld === 'function') {
    return WorldGen.ensureWorld(state);
  }
  console.log('[Engine] No world generator found, using fallback');
  return state;
}

function normalizeDir(raw) {
  const s = String(raw || '').trim().toLowerCase();
  const map = {
    n: 'N', north: 'N', s: 'S', south: 'S',
    e: 'E', east: 'E', w: 'W', west: 'W',
    ne: 'NE', northeast: 'NE', nw: 'NW', northwest: 'NW',
    se: 'SE', southeast: 'SE', sw: 'SW', southwest: 'SW'
  };
  return map[s] || null;
}

function applyMovementAdapter(state, dir) {
  if (!dir) return state;
  if (WorldGen && typeof WorldGen.parseAndApplyMovement === 'function') {
    console.log('[Engine] Using WorldGen.parseAndApplyMovement');
    return WorldGen.parseAndApplyMovement(state, dir);
  }
  if (WorldGen && typeof WorldGen.applyMovement === 'function') {
    console.log('[Engine] Using WorldGen.applyMovement');
    return WorldGen.applyMovement(state, dir);
  }
  console.log('[Engine] Using fallback movement');
  const deltaMap = {
    N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0],
    NE: [1, -1], NW: [-1, -1], SE: [1, 1], SW: [-1, 1]
  };
  const delta = deltaMap[dir];
  if (!delta) return state;
  const [dx, dy] = delta;
  const world = state.world || {};
  const pos = world.position || { mx: 0, my: 0, lx: 6, ly: 6 };
  const maxX = (world.l1_default?.w || 12) - 1;
  const maxY = (world.l1_default?.h || 12) - 1;
  const newLx = Math.max(0, Math.min(maxX, (pos.lx || 0) + dx));
  const newLy = Math.max(0, Math.min(maxY, (pos.ly || 0) + dy));
  return {
    ...state,
    world: { ...world, position: { ...pos, lx: newLx, ly: newLy } }
  };
}
// === End Adapters ===

// Shared defaults must match modules
const DEFAULTS = {
  L0_SIZE: { w: 8, h: 8 },
  L1_SIZE: { w: 12, h: 12 },
  STREAM: { R: 2, P: 1 },
};

function toISO8601(value) {
  const d = value ? new Date(value) : new Date();
  return d.toISOString();
}

let TURN_SEQ = 0;
function genTurnId(provided) {
  if (provided) return String(provided);
  const ts = Date.now();
  const pid = (typeof process !== 'undefined' && process && process.pid) ? process.pid : Math.floor(Math.random()*1e5);
  const rnd = Math.floor(Math.random()*1e9);
  const seq = (TURN_SEQ++ & 0xFFFFFFFF);
  return `t${ts}_${pid}_${seq}_${rnd}`;
}
function l0Id(mx, my) {
  const row = String.fromCharCode('A'.charCodeAt(0) + mx);
  const col = (my + 1);
  return row + col;
}
function stateFingerprintStableHex(state) {
  const sf = state.fingerprint.stable_fields || {};
  const schema_version = String(sf.schema_version ?? '1.1.0');
  const world_seed = String(sf.world_seed ?? 0);
  const ruleset_rev = String(sf.ruleset_rev ?? 1);
  const concat = `${schema_version}|${world_seed}|${ruleset_rev}`;
  return crypto.createHash('sha256').update(concat,'utf8').digest('hex');
}
function stateFingerprintFullHex(state) {
  const proj = {
    schema_version: state.schema_version,
    rng_seed: state.rng_seed,
    turn_counter: state.turn_counter,
    player: state.player,
    world: state.world,
    counters: state.counters,
    digests: state.digests,
    history_len: Array.isArray(state.history) ? state.history.length : 0,
    ledger_len: (state.ledger && Array.isArray(state.ledger.promotions)) ? state.ledger.promotions.length : 0
  };
  const s = JSON.stringify(proj);
  return crypto.createHash('sha256').update(s,'utf8').digest('hex');
}

function initState(timestampUTC) {
  const l1w = DEFAULTS.L1_SIZE.w, l1h = DEFAULTS.L1_SIZE.h;
  return {
    schema_version: "1.1.0",
    rng_seed: 0,
    turn_counter: 0,
    player: { id: "player-1", aliases: ["you"], stats: { stamina: 100, clarity: 100 }, inventory: [] },
    world: {
      time_utc: timestampUTC,
      l0: { w: DEFAULTS.L0_SIZE.w, h: DEFAULTS.L0_SIZE.h },
      l1_default: { w: l1w, h: l1h },
      stream: { R: DEFAULTS.STREAM.R, P: DEFAULTS.STREAM.P },
      position: { mx: 0, my: 0, lx: Math.floor(l1w/2), ly: Math.floor(l1h/2) },
      cells: {},
      l2_active: null,
      l3_active: null,
      current_layer: 1,
      npcs: []
    },
    counters: { state_rev: 0 },
    fingerprint: {
      stable_fields: { schema_version: "1.1.0", world_seed: 0, ruleset_rev: 1 },
      hex_digest: "",
      hex_digest_stable: "",
      hex_digest_state: ""
    },
    digests: { inventory_digest: "" },
    quests: [], reputation: {},
    history: []
  };
}

function buildOutput(prevState, inputObj) {
  const nowUTC = toISO8601(inputObj && inputObj["timestamp_utc"]);
  const turnId = genTurnId(inputObj && inputObj["turn_id"]);
  let state = prevState ? deepClone(prevState) : initState(nowUTC);
  // Route based on intent kind
  const kind = inputObj?.player_intent?.kind || 'FREEFORM';
  const raw = inputObj?.player_intent?.raw || '';
  if (kind === 'WORLD_PROMPT') {
    state = generateWorldFromDescriptionAdapter(state, raw);
  } else if (kind === 'MOVE') {
    const dir = inputObj?.player_intent?.dir || normalizeDir(raw);
    state = applyMovementAdapter(state, dir);
  }

  const changes1 = [];
  const changes2 = [];
  const phaseFlags = { inventory_rev:false, merchant_state_rev:false, faction_rev:false };

  // Time delta
  state.world.time_utc = nowUTC;
  changes1.push({ op:"set", path:"/world/time_utc", value: nowUTC });

  // Phase C pre: expiry tick
  // Actions.tickMerchantsAndFactions(state, nowUTC, changes1, phaseFlags);

  // Phase A: ensure L1 window hydrated & optional autodescription
  ensureL1WindowHydrated(state, changes1);
  ensureAutoCellDescriptions(state, changes1);

  // Phase B: apply player actions (non-movement here)
  const actions = (inputObj && inputObj.player_actions) || [];
  Actions.applyPlayerActions(state, actions, changes2, phaseFlags);

  // Digest inventory
  const invHex = Actions.computeInventoryDigestHex(state);
  state.digests.inventory_digest = invHex;

  // Turn counter + periodic regen
  state.turn_counter = (state.turn_counter|0) + 1;

  // Fingerprints
  state.fingerprint.hex_digest_stable = stateFingerprintStableHex(state);
  state.fingerprint.hex_digest_state = crypto.createHash('sha256')
    .update(JSON.stringify(state),'utf8').digest('hex');
  state.fingerprint.hex_digest = stateFingerprintFullHex(state);

  // History entry
  const hist = {
    turn_id: turnId,
    timestamp_utc: nowUTC,
    labels: ["PLAYER","INVENTORY","QUESTS","WORLD","MERCHANTS","FACTIONS","DIGESTS","COUNTERS"],
    changes: changes1.concat(changes2)
  };
  if (!Array.isArray(state.history)) state.history = [];
  state.history.push(hist);

  return {
    state,
    deltas: hist.changes
  };
}

// === Helpers (unchanged) ===

function ensureL1WindowHydrated(state, changes){
  if (!state.world || !state.world.cells) state.world.cells = {};
  // Hydrate a simple window around current position if missing
  const w = state.world.l1_default.w, h = state.world.l1_default.h;
  const pos = state.world.position;
  const R = state.world.stream.R;
  for (let dx = -R; dx <= R; dx++){
    for (let dy = -R; dy <= R; dy++){
      const lx = Math.max(0, Math.min(w-1, pos.lx + dx));
      const ly = Math.max(0, Math.min(h-1, pos.ly + dy));
      const id = `L1:${pos.mx},${pos.my}:${lx},${ly}`;
      if (!state.world.cells[id]){
        state.world.cells[id] = { id, mx: pos.mx, my: pos.my, lx, ly, type: "plain", subtype: "grass" };
        changes.push({ op:"set", path:`/world/cells/${id}`, value: state.world.cells[id] });
      }
    }
  }
}
function ensureAutoCellDescriptions(state, changes){
  const cells = state.world.cells || {};
  for (const id of Object.keys(cells)){
    const cell = cells[id];
    if (!cell.description){
      const desc = `You see ${cell.subtype} at (${cell.lx},${cell.ly}) in ${l0Id(cell.mx, cell.my)}.`;
      cell.description = desc;
      changes.push({ op:"set", path:`/world/cells/${id}/description`, value: desc });
    }
  }
}
// === Layer Transition Adapters (restored) ===
function enterL2FromL1(state, l1_cell_data) {
  if (WorldGen && typeof WorldGen.enterL2FromL1 === 'function') {
    return WorldGen.enterL2FromL1(state, l1_cell_data);
  }
  return state;
}
function enterL3FromL2(state, building_id_short) {
  if (WorldGen && typeof WorldGen.enterL3FromL2 === 'function') {
    return WorldGen.enterL3FromL2(state, building_id_short);
  }
  return state;
}
function exitL2ToL1(state) {
  if (WorldGen && typeof WorldGen.exitL2ToL1 === 'function') {
    return WorldGen.exitL2ToL1(state);
  }
  return state;
}
function exitL3ToL2(state) {
  if (WorldGen && typeof WorldGen.exitL3ToL2 === 'function') {
    return WorldGen.exitL3ToL2(state);
  }
  return state;
}

// === deepClone (restored full implementation) ===
function deepClone(input, seen = new WeakMap()) {
  if (input === null || typeof input !== 'object') return input;

  if (seen.has(input)) return seen.get(input);

  // Date
  if (input instanceof Date) return new Date(input.getTime());

  // RegExp
  if (input instanceof RegExp) {
    const re = new RegExp(input.source, input.flags);
    re.lastIndex = input.lastIndex;
    return re;
  }

  // Buffer (Node.js)
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(input)) {
    const out = Buffer.allocUnsafe(input.length);
    input.copy(out);
    return out;
  }

  // Typed arrays
  const typedArrayNames = [
    'Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array',
    'Int32Array','Uint32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array'
  ];
  for (const name of typedArrayNames) {
    if (typeof globalThis[name] === 'function' && input instanceof globalThis[name]) {
      return new globalThis[name](input);
    }
  }

  // Map
  if (input instanceof Map) {
    const out = new Map();
    seen.set(input, out);
    for (const [k,v] of input.entries()) {
      out.set(deepClone(k, seen), deepClone(v, seen));
    }
    return out;
  }

  // Set
  if (input instanceof Set) {
    const out = new Set();
    seen.set(input, out);
    for (const v of input.values()) {
      out.add(deepClone(v, seen));
    }
    return out;
  }

  // Array
  if (Array.isArray(input)) {
    const out = new Array(input.length);
    seen.set(input, out);
    for (let i = 0; i < input.length; i++) {
      out[i] = deepClone(input[i], seen);
    }
    return out;
  }

  // Plain Object (preserve prototype if not null)
  const proto = Object.getPrototypeOf(input);
  const out = Object.create(proto === null ? null : proto);
  seen.set(input, out);
  for (const key of Reflect.ownKeys(input)) {
    const desc = Object.getOwnPropertyDescriptor(input, key);
    if (desc) {
      if ('value' in desc) {
        desc.value = deepClone(input[key], seen);
      }
      try {
        Object.defineProperty(out, key, desc);
      } catch (_) {
        // Fallback if property is non-configurable on target
        out[key] = desc && 'value' in desc ? desc.value : input[key];
      }
    } else {
      out[key] = deepClone(input[key], seen);
    }
  }
  return out;
}

// Update exports to include restored functions
module.exports = {
  initState, buildOutput,
  enterL2FromL1, enterL3FromL2, exitL2ToL1, exitL3ToL2
};
