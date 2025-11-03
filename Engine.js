// Engine.js — orchestrator; preserves v118 behavior byte-for-byte on state
const readline = require('readline');
const crypto = require('crypto');
const WorldGen = require('./WorldGen.v4.patched (1)');
const Actions = require('./ActionProcessor.v2.patched');

// Shared defaults must match modules
const DEFAULTS = {
  L0_SIZE: { w: 8, h: 8 },
  L1_SIZE: { w: 12, h: 12 },
  STREAM: { R: 2, P: 1 },
};

function toISO8601(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}
function deepClone(input, seen = new WeakMap()) {
  if (input === null || typeof input !== 'object') return input;
  if (seen.has(input)) return seen.get(input);
  if (Array.isArray(input)) {
    const arr = [];
    seen.set(input, arr);
    for (const v of input) arr.push(deepClone(v, seen));
    return arr;
  }
  if (input instanceof Date) return new Date(input.getTime());
  if (input instanceof RegExp) return new RegExp(input.source, input.flags);
  const out = {};
  seen.set(input, out);
  for (const k of Object.keys(input)) out[k] = deepClone(input[k], seen);
  return out;
}
let TURN_SEQ = 0;
function genTurnId(userProvided) {
  if (userProvided && typeof userProvided === 'string' && userProvided.trim().length > 0) return userProvided;
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
      macro: {}, cells: {}, sites: {},
      merchants: [], factions: [], npcs: [],
      position: { mx: 0, my: 0, lx: Math.floor(l1w/2), ly: Math.floor(l1h/2) }
    },
    ledger: { promotions: [] },
    counters: { state_rev: 0, site_rev: 0, cell_rev: 0, inventory_rev: 0, merchant_state_rev: 0, faction_rev: 0 },
    fingerprint: {
      stable_fields: { schema_version: "1.1.0", world_seed: 0, ruleset_rev: 1 },
      hash_alg: "SHA-256",
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
  const state = prevState ? deepClone(prevState) : initState(nowUTC);

  const changes1 = [];
  const changes2 = [];
  const phaseFlags = { inventory_rev:false, merchant_state_rev:false, faction_rev:false };

  // Time delta
  state.world.time_utc = nowUTC;
  changes1.push({ op:"set", path:"/world/time_utc", value: nowUTC });

  // Phase C pre: expiry tick
  Actions.tickMerchantsAndFactions(state, nowUTC, changes1, phaseFlags);

  // Parse & apply player actions (non-movement)
  const actions = Actions.parseIntent(inputObj ? inputObj["player_intent"] : "") || { action:'noop' };
  Actions.applyPlayerActions(state, actions, changes1, phaseFlags);

  // WorldGen step (movement + streaming + site reveal)
  const wg = WorldGen.worldGenStep(state, { actions });
  // deltas are already pushed by worldGenStep to changes1-equivalent; merge:
  if (wg && Array.isArray(wg.deltas)) {
    for (const d of wg.deltas) changes1.push(d);
  }

  // L1 description pass: ensure each visible cell has a narrative description
  if (state && state.world && state.world.cells) {
    for (const id in state.world.cells) {
      const cell = state.world.cells[id];
      if (!cell) continue;
      if (!cell.description) {
        const desc = WorldGen.generateL1FeatureDescription({
          type: (cell.category || cell.tags?.category || "geography"),
          subtype: (cell.type || cell.tags?.type || "default"),
          mx: cell.mx ?? state.world.position.mx,
          my: cell.my ?? state.world.position.my,
          lx: cell.lx,
          ly: cell.ly
        });
        cell.description = desc;
        changes1.push({ op: "set", path: `/world/cells/${id}/description`, value: desc });
      }
    }
  }


  // Digest inventory
  const invHex = Actions.computeInventoryDigestHex(state);
  state.digests.inventory_digest = invHex;

  // Turn counter + periodic regen
  state.turn_counter = (state.turn_counter|0) + 1;
  if (state.turn_counter % 10 === 0) Actions.merchantRegenOnTurn(state, nowUTC, changes1, phaseFlags);

  // Counters
  if (phaseFlags.inventory_rev) { state.counters.inventory_rev = (state.counters.inventory_rev|0) + 1; changes1.push({ op:'inc', path:'/counters/inventory_rev', value:1 }); }
  if (phaseFlags.merchant_state_rev) { state.counters.merchant_state_rev = (state.counters.merchant_state_rev|0) + 1; changes1.push({ op:'inc', path:'/counters/merchant_state_rev', value:1 }); }

  if (changes1.length > 0) {
    state.counters.state_rev = (state.counters.state_rev|0) + 1;
    changes1.push({ op:"inc", path:"/counters/state_rev", value:1 });
  }

  const pos = state.world.position;
  const planMeta = (function(){
    const macroKey = `${pos.mx},${pos.my}`;
    const macro = state.world.macro && state.world.macro[macroKey];
    const sp = macro && macro.site_plan;
    return sp ? sp.meta : null;
  })();

  const known = new Set();
  for (const id in state.world.cells) {
    const c = state.world.cells[id];
    if (c.mx !== pos.mx || c.my !== pos.my) continue;
    if (c.hydrated) known.add(`M${c.mx}x${c.my}/L${c.lx}x${c.ly}`);
  }
  const macro = state.world.macro[`${pos.mx},${pos.my}`];
  const plan = macro && macro.site_plan || { clusters: [] };
  const cluster_meta = plan.clusters.map(cl => {
    const visible_cells = [];
    for (const seg of cl.cells) {
      const k = `M${pos.mx}x${pos.my}/L${seg.lx}x${seg.ly}`;
      if (known.has(k)) visible_cells.push({ lx: seg.lx, ly: seg.ly });
    }
    return { cluster_id: cl.cluster_id, tier: cl.tier, total_segments: cl.cells.length, visible_segments: visible_cells.length, visible_cells };
  });

  const delta1 = {
    turn_id: turnId,
    labels: ["PLAYER","INVENTORY","QUESTS","WORLD","CELLS","SITES","MERCHANTS","FACTIONS","COUNTERS"],
    changes: changes1,
    post_state_facts: {
      position: { ...state.world.position },
      l0_id: l0Id(pos.mx,pos.my),
      l1_dims: { ...state.world.l1_default },
      stream: { ...state.world.stream },
      cluster_meta,
      site_plan_meta: planMeta,
      inventory_digest: state.digests.inventory_digest
    }
  };

  const history_entry = {
    turn_id: turnId,
    timestamp_utc: nowUTC,
    intent: (inputObj && inputObj["player_intent"]) || "",
    summary: (actions.action === 'move' ? `You move ${actions.dir?.toUpperCase()}.` :
             (actions.action==='look' ? "You look around." :
             (actions.action==='take' ? `You try to take ${actions.target||''}.` :
             (actions.action==='drop' ? `You drop ${actions.target||''}.` : "Time passes."))))
  };
  if (!Array.isArray(state.history)) state.history = [];
  state.history.push(history_entry);

  const fpStable = stateFingerprintStableHex(state);
  const fpState  = stateFingerprintFullHex(state);
  state.fingerprint.hex_digest_stable = fpStable;
  state.fingerprint.hex_digest_state  = fpState;
  state.fingerprint.hex_digest        = fpState;

  const delta2 = {
    turn_id: turnId,
    labels: ["HISTORY","FINGERPRINT"],
    changes: [
      { op:"add", path:"/history/-", value: history_entry },
      { op:"set", path:"/fingerprint/hex_digest_stable", value: fpStable },
      { op:"set", path:"/fingerprint/hex_digest_state",  value: fpState },
      { op:"set", path:"/fingerprint/hex_digest",        value: fpState }
    ],
    post_state_facts: {
      summary: {
        cells_total: Object.keys(state.world.cells).length,
        sites_total: Object.keys(state.world.sites).length
      },
      fingerprint: fpState
    }
  };

  const blocks = [];
  blocks.push("[STATE-DELTA 1/2]\n" + JSON.stringify(delta1, null, 2));
  blocks.push("[STATE-DELTA 2/2]\n" + JSON.stringify(delta2, null, 2));
  return { blocks, state };
}

// CLI harness (compatible with v118 workflow)
function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let buf = '';
  rl.on('line', line => { buf += line + '\n'; });
  rl.on('close', () => {
    buf = buf.trim();
    try {
      const inputObj = JSON.parse(buf || "{}");
      const prev = inputObj.previous_state || null;
      const { blocks } = buildOutput(prev, inputObj);
      for (let i = 0; i < blocks.length; i++) {
        process.stdout.write(blocks[i]);
        if (i < blocks.length - 1) process.stdout.write('\n\n');
      }
    } catch (e) {
      process.stdout.write(JSON.stringify({ error:"INVALID_INPUT_JSON", detail:String(e && e.message || e) }));
      process.exit(1);
    }
  });
}
if (require.main === module) main();


/**
 * Enter an L2 location (settlement or POI) from an L1 cell.
 */
function enterL2FromL1(state, l1_cell_data) {
  if (!state || !state.world || !l1_cell_data) return null;
  const { mx, my, lx, ly, type, subtype } = l1_cell_data;
  const l2_id = `M${mx}x${my}/L1_${lx}_${ly}_${subtype}`;
  let npcs_here = [];
  if (Array.isArray(state.world.npcs)) {
    npcs_here = state.world.npcs.filter(n => n && (n.home_location === l2_id || n.site_id === l2_id));
  }
  let l2 = null;
  if (type === "settlement") {
    l2 = WorldGen.generateL2Settlement(l2_id, subtype, npcs_here);
  } else if (type === "poi") {
    l2 = WorldGen.generateL2POI(l2_id, subtype);
  } else {
    // fallback: treat as structure
    l2 = WorldGen.generateL2POI(l2_id, "structure");
  }
  state.world.l2_active = l2;
  state.world.l3_active = null;
  state.world.current_layer = 2;
  if (!state.player) state.player = {};
  state.player.layer = 2;
  state.player.position = { x: 0, y: 0 };
  return l2;
}

/**
 * Enter an L3 building from currently active L2.
 */
function enterL3FromL2(state, building_id_short) {
  if (!state || !state.world || !state.world.l2_active) return null;
  const l2 = state.world.l2_active;
  const bld = l2.buildings[building_id_short];
  if (!bld) return null;
  const full_id = `${l2.settlement_id}_${building_id_short}`;
  const l3 = WorldGen.generateL3Building(full_id, bld);
  state.world.l3_active = l3;
  state.world.current_layer = 3;
  if (!state.player) state.player = {};
  state.player.layer = 3;
  return l3;
}

/**
 * Exit back to L1 from L2.
 */
function exitL2ToL1(state) {
  if (!state || !state.world) return;
  state.world.l2_active = null;
  state.world.current_layer = 1;
  if (!state.player) state.player = {};
  state.player.layer = 1;
}

/**
 * Exit back to L2 from L3.
 */
function exitL3ToL2(state) {
  if (!state || !state.world) return;
  state.world.l3_active = null;
  state.world.current_layer = 2;
  if (!state.player) state.player = {};
  state.player.layer = 2;
}

module.exports = { buildOutput, initState, enterL2FromL1, enterL3FromL2, exitL2ToL1, exitL3ToL2 };
