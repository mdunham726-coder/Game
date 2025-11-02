// WorldGen.js — extracted from v117/v118 (no refactors; same behavior)
const crypto = require('crypto');

// --- Constants / Defaults (must match Engine/ActionProcessor) ---
const WORLD_WRAP = false;
const DEFAULTS = {
  L0_SIZE: { w: 8, h: 8 },
  L1_SIZE: { w: 12, h: 12 },
  STREAM: { R: 2, P: 1 },
  DENSITY: { target_min: 7, target_max: 11,
    spacing: { outpost: 1, hamlet: 2, town: 3, city: 4, metropolis: 6 } },
  FOOTPRINT: { outpost: 1, hamlet: 1, town: 1, city: 3, metropolis: 7 },
  CAPS_PER_MACRO: { metropolis: 0, city: 1 }
};

// --- RNG / Helpers (identical behavior) ---
function h32(key) {
  const hex = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
  return (parseInt(hex.slice(0, 8), 16) >>> 0);
}
function mulberry32(a) {
  let t = a >>> 0;
  return function() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ t >>> 15, 1 | t);
    r ^= r + Math.imul(r ^ r >>> 7, 61 | r);
    return ((r ^ r >>> 14) >>> 0) / 4294967296;
  };
}
function rnd01(seed, parts) {
  const k = [String(seed), ...parts.map(String)].join('|');
  return mulberry32(h32(k))();
}
function rndInt(seed, parts, min, max) {
  if (max < min) [min, max] = [max, min];
  const r = rnd01(seed, parts);
  const span = (max - min + 1);
  let out = min + Math.floor(r * span);
  if (out < min) out = min;
  if (out > max) out = max;
  return out;
}
function clamp(v, lo, hi){
  if (Number.isNaN(lo) || Number.isNaN(hi)) return v;
  if (lo > hi) { const tmp = lo; lo = hi; hi = tmp; }
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
function l0Id(mx, my) {
  const row = String.fromCharCode('A'.charCodeAt(0) + mx);
  const col = (my + 1);
  return row + col;
}
function byKey(mx, my, lx, ly) { return `M${mx}x${my}/L${lx}x${ly}`; }
function siteId(mx, my, clusterId, segIndex) {
  return `M${mx}x${my}/S${clusterId}${segIndex != null ? ('#' + segIndex) : ''}`;
}

// --- Core worldgen internals (same as v117/v118) ---
function ensureMacro(state, mx, my) {
  const mmx = clamp(mx, 0, state.world.l0.w - 1);
  const mmy = clamp(my, 0, state.world.l0.h - 1);
  const key = `${mmx},${mmy}`;
  if (state.world.macro[key]) return state.world.macro[key];
  const l1def = state.world.l1_default || DEFAULTS.L1_SIZE;
  state.world.macro[key] = {
    id: l0Id(mmx,mmy),
    mx: mmx, my: mmy,
    l1: { w: l1def.w, h: l1def.h },
    caps: { ...DEFAULTS.CAPS_PER_MACRO },
    site_plan: null,
    name: l0Id(mmx,mmy)
  };
  return state.world.macro[key];
}

function clampPositionToMacro(state) {
  const p = state.world.position;
  const maxMx = state.world.l0.w - 1;
  const maxMy = state.world.l0.h - 1;
  p.mx = clamp(p.mx, 0, maxMx);
  p.my = clamp(p.my, 0, maxMy);
  const macro = ensureMacro(state, p.mx, p.my);
  const W = ((macro && macro.l1 && typeof macro.l1.w === 'number') ? macro.l1.w : ((state.world.l1_default && state.world.l1_default.w) || DEFAULTS.L1_SIZE.w));
  const H = ((macro && macro.l1 && typeof macro.l1.h === 'number') ? macro.l1.h : ((state.world.l1_default && state.world.l1_default.h) || DEFAULTS.L1_SIZE.h));
  p.lx = clamp(p.lx, 0, W-1);
  p.ly = clamp(p.ly, 0, H-1);
}

function planSitesForMacro(state, mx, my) {
  const macro = ensureMacro(state, mx, my);
  if (macro.site_plan) return JSON.parse(JSON.stringify(macro.site_plan));
  const { w, h } = macro.l1;
  const target = rndInt(state.rng_seed, ['target', mx, my], DEFAULTS.DENSITY.target_min, DEFAULTS.DENSITY.target_max);
  const occupied = Array.from({length:h}, ()=>Array.from({length:w}, ()=>false));
  const clusters = [];
  let cap_city = macro.caps.city ?? 1;
  let cap_metro = macro.caps.metropolis ?? 0;
  function okSpacing(lx, ly, tier) {
    const r = DEFAULTS.DENSITY.spacing[tier];
    for (const cl of clusters) {
      const cx = cl.cells[0].lx, cy = cl.cells[0].ly;
      if (Math.max(Math.abs(cx - lx), Math.abs(cy - ly)) < r) return false;
    }
    return true;
  }
  function inBounds(x,y){ return x>=0 && y>=0 && x<w && y<h; }
  let epoch = 0;
  function tryPlaceCluster(tier) {
    const tries = 80;
    for (let tryIdx=0; tryIdx<tries; tryIdx++) {
      const lx = rndInt(state.rng_seed,['cell',mx,my,tier,'x',tryIdx,'ep',epoch],0,w-1);
      const ly = rndInt(state.rng_seed,['cell',mx,my,tier,'y',tryIdx,'ep',epoch],0,h-1);
      if (occupied[ly][lx]) continue;
      if (!okSpacing(lx,ly,tier)) continue;
      let fp = DEFAULTS.FOOTPRINT[tier] || 1;
      const cells = [{lx,ly}];
      occupied[ly][lx] = true;
      if (fp>1){
        const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
        let attempt = 0;
        while (cells.length < fp && attempt < 200) {
          attempt++;
          const base = cells[rndInt(state.rng_seed,['base',mx,my,tier,attempt,'ep',epoch],0,cells.length-1)];
          const d = dirs[rndInt(state.rng_seed,['dir',mx,my,tier,attempt,'ep',epoch],0,dirs.length-1)];
          const nx = base.lx + d[0], ny = base.ly + d[1];
          if (inBounds(nx,ny) && !occupied[ny][nx]) {
            occupied[ny][nx] = true;
            cells.push({lx:nx,ly:ny});
          }
        }
      }
      clusters.push({ tier, cells, cluster_id: `${mx}x${my}_${clusters.length+1}` });
      epoch++;
      return true;
    }
    epoch++;
    return false;
  }
  let placed = 0;
  if (cap_metro > 0) { if (tryPlaceCluster('metropolis')) { placed++; cap_metro--; } }
  if (cap_city  > 0 && placed < target) { if (tryPlaceCluster('city')) { placed++; cap_city--; } }
  let townAttempts = 0, TOWN_TRY_BUDGET = 200;
  while (placed < target && townAttempts < TOWN_TRY_BUDGET) { if (tryPlaceCluster('town')) placed++; else townAttempts++; }
  let flip = true, minorAttempts = 0, MINOR_TRY_BUDGET = w*h*2;
  while (placed < target && minorAttempts < MINOR_TRY_BUDGET) { if (tryPlaceCluster(flip?'hamlet':'outpost')) placed++; else minorAttempts++; flip = !flip; }
  const meta = { placed, target, warn_shortfall: placed < target };
  if (meta.warn_shortfall) console.warn(`[WARN] Macro M${mx}x${my}: placed ${placed} sites, target was ${target}`);
  const plan = { target, clusters, meta };
  macro.site_plan = JSON.parse(JSON.stringify(plan));
  return JSON.parse(JSON.stringify(plan));
}

function hydrateL1Window(state, deltas) {
  const { R, P } = state.world.stream;
  const pos = state.world.position;
  const macro = ensureMacro(state, pos.mx, pos.my);
  const W = macro.l1.w, H = macro.l1.h;
  const changed = new Set();
  function markCell(lx,ly, hydrated) {
    if (!pos || typeof pos.mx !== 'number' || typeof pos.my !== 'number' || typeof pos.lx !== 'number' || typeof pos.ly !== 'number') return;
    const id = byKey(pos.mx,pos.my,lx,ly);
    let c = state.world.cells[id];
    if (!c) {
      c = state.world.cells[id] = { id, mx:pos.mx, my:pos.my, lx, ly, known: true, hydrated: !!hydrated, tags: {} };
      if (!changed.has(id)) {
        deltas.push({ op:"add", path:`/world/cells/${id}`, value: c });
        changed.add(id);
      }
      state.counters.cell_rev++;
    } else {
      let touched = false;
      if (!c.known) { c.known = true; touched = true; }
      if (!!hydrated !== !!c.hydrated) { c.hydrated = !!hydrated; touched = true; }
      if (touched && !changed.has(id)) {
        deltas.push({ op:"set", path:`/world/cells/${id}`, value: c });
        changed.add(id);
        state.counters.cell_rev++;
      }
    }
  }
  for (let dy = -(R+P); dy <= (R+P); dy++) {
    for (let dx = -(R+P); dx <= (R+P); dx++) {
      const lx = pos.lx + dx, ly = pos.ly + dy;
      if (lx < 0 || ly < 0 || lx >= W || ly >= H) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const hydrate = dist <= R;
      markCell(lx, ly, hydrate);
    }
  }
  const toDelete = [];
  for (const id in state.world.cells) {
    const c = state.world.cells[id];
    if (c.mx !== pos.mx || c.my !== pos.my) continue;
    const dx = c.lx - pos.lx, dy = c.ly - pos.ly;
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    if (dist > (R+P)) toDelete.push(id);
  }
  for (const id of toDelete) {
    delete state.world.cells[id];
    deltas.push({ op:"del", path:`/world/cells/${id}` });
    state.counters.cell_rev++;
  }
}

function exposeSitesInWindow(state, deltas) {
  const pos = state.world.position;
  const plan = planSitesForMacro(state, pos.mx, pos.my);
  const { R, P } = state.world.stream;
  const known = new Set();
  for (const id in state.world.cells) {
    const c = state.world.cells[id];
    if (c.mx !== pos.mx || c.my !== pos.my) continue;
    if (c.hydrated) known.add(byKey(c.mx,c.my,c.lx,c.ly)); // hydrated gate
  }
  for (const cl of plan.clusters) {
    for (let i=0;i<cl.cells.length;i++) {
      const cell = cl.cells[i];
      const dx = cell.lx - pos.lx, dy = cell.ly - pos.ly;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      if (dist > (R+P)) continue;
      const k = byKey(pos.mx,pos.my,cell.lx, cell.ly);
      if (!known.has(k)) continue;
      const sid = siteId(pos.mx,pos.my, cl.cluster_id, i);
      if (!state.world.sites[sid]) {
        const siteObj = { id:sid, mx:pos.mx, my:pos.my, cluster_id:cl.cluster_id, seg_index:i, tier:cl.tier, cells:cl.cells, promoted:false };
        state.world.sites[sid] = siteObj;
        deltas.push({ op:"add", path:`/world/sites/${sid}`, value: siteObj });
        state.counters.site_rev++;
      }
    }
  }
}

function applyMovement(state, actions, deltas) {
  if (!actions || actions.action !== 'move') return;
  const dir = actions.dir;
  if (!['n','s','e','w'].includes(dir)) return;
  const p = state.world.position;
  const macro = ensureMacro(state, p.mx, p.my);
  const W = macro.l1.w, H = macro.l1.h;
  let nx = p.lx, ny = p.ly;
  if (dir === 'n') ny -= 1;
  if (dir === 's') ny += 1;
  if (dir === 'w') nx -= 1;
  if (dir === 'e') nx += 1;
  if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
  p.lx = nx; p.ly = ny;
  deltas.push({ op:"set", path:"/world/position", value: { ...p } });
}

// Public step: movement + hydrate + site reveal (identical to v118 order after actions)
function worldGenStep(state, input){
  const deltas = [];
  // position sanity
  const p = state.world.position || (state.world.position = { mx:0, my:0, lx:Math.floor((state.world.l1_default||DEFAULTS.L1_SIZE).w/2), ly:Math.floor((state.world.l1_default||DEFAULTS.L1_SIZE).h/2) });
  clampPositionToMacro(state);
  // movement
  applyMovement(state, input?.actions || {action:'noop'}, deltas);
  // window + sites
  hydrateL1Window(state, deltas);
  exposeSitesInWindow(state, deltas);
  return { state, deltas };
}


/**
 * Simple LCG for deterministic generation (matches NPC system parameters).
 * @param {number} seed
 */
function makeLCG(seed) {
  const a = 1103515245;
  const c = 12345;
  const m = 0x80000000; // 2^31
  let s = (seed >>> 0) & 0x7fffffff;
  return {
    next() {
      s = (a * s + c) & 0x7fffffff;
      return s >>> 0;
    },
    nextFloat() {
      return this.next() / m;
    },
    nextInt(max) {
      const n = this.next();
      return max > 0 ? (n % max) : 0;
    }
  };
}

/**
 * Hash any location id (L0/L1/L2/L3) into a 31-bit seed.
 * @param {string} id
 * @returns {number}
 */
function hashSeedFromLocationID(id) {
  if (typeof id !== 'string') return 0;
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h) + id.charCodeAt(i);
    h &= 0x7fffffff;
  }
  return h >>> 0;
}

const SETTLEMENT_SIZES = {
  hut:       { width: 2, height: 2, buildings: 1, tier: "humble" },
  village:   { width: 4, height: 4, buildings: 3, tier: "humble" },
  town:      { width: 6, height: 6, buildings: 5, tier: "modest" },
  city:      { width: 8, height: 8, buildings: 7, tier: "modest" },
  metropolis:{ width: 10, height: 10, buildings: 10, tier: "grand" }
};

const POI_SIZES = {
  cave:      { width: 3, height: 3 },
  ruin:      { width: 3, height: 3 },
  structure: { width: 2, height: 2 }
};

const L1_DESCRIPTION_TEMPLATES = {
  settlement: {
    hut: [
      "A lonely hut stands here, smoke curling lazily from its chimney.",
      "A small homestead sits on the rise, with signs of recent activity."
    ],
    village: [
      "A small village nestles in the valley. Smoke rises from clustered roofs.",
      "A ring of cottages surrounds a central well. Voices carry on the wind."
    ],
    town: [
      "A bustling town square anchors this place. Merchants shout over one another.",
      "Timber-framed houses and a few sturdy shops line a main street."
    ],
    city: [
      "Stone walls and watchtowers mark a sizable city. Traffic flows through its gates.",
      "A dense city sprawls here, layered with markets, temples, and workshops."
    ],
    metropolis: [
      "A vast metropolis dominates the landscape, throbbing with trade and intrigue.",
      "Countless rooftops, towers, and plazas stretch as far as the eye can see."
    ]
  },
  poi: {
    cave: [
      "A dark cave mouth gapes before you. Cool air whispers from within.",
      "A limestone opening reveals descending tunnels and faint echoes."
    ],
    ruin: [
      "Crumbling stonework and shattered columns hint at a lost civilization.",
      "An overgrown ruin lies here, half-swallowed by roots and time."
    ],
    structure: [
      "A lone structure stands in defiance of the surrounding wilds.",
      "A watchful outbuilding sits here, its purpose unclear."
    ]
  },
  geography: {
    forest: [
      "Thick forest crowds the area, branches interlaced overhead.",
      "A stand of old trees forms a natural barrier and muffles sound."
    ],
    field: [
      "Open fields roll gently, dotted with wildflowers and low grass.",
      "A breezy plain stretches outward, easy to traverse and to spot danger from."
    ],
    default: [
      "Uneventful terrain spreads out here.",
      "A quiet patch of land without notable features."
    ]
  }
};

/**
 * Generate a short narrative description for an L1 cell.
 * Deterministic from provided seed or derived from coords.
 */
function generateL1FeatureDescription(l1_cell_data) {
  if (!l1_cell_data) return "Unremarkable ground.";
  let { type, subtype, seed, mx, my, lx, ly } = l1_cell_data;
  type = type || "geography";
  subtype = subtype || "default";
  if (typeof seed !== "number") {
    if (typeof mx === "number" && typeof my === "number" && typeof lx === "number" && typeof ly === "number") {
      const id = `M${mx}x${my}/L1_${lx}_${ly}_${type}_${subtype}`;
      seed = hashSeedFromLocationID(id);
    } else {
      seed = hashSeedFromLocationID(type + ":" + subtype);
    }
  }
  const rng = makeLCG(seed);
  let pool;
  if (L1_DESCRIPTION_TEMPLATES[type] && L1_DESCRIPTION_TEMPLATES[type][subtype]) {
    pool = L1_DESCRIPTION_TEMPLATES[type][subtype];
  } else if (L1_DESCRIPTION_TEMPLATES[type] && L1_DESCRIPTION_TEMPLATES[type].default) {
    pool = L1_DESCRIPTION_TEMPLATES[type].default;
  } else {
    pool = ["Nothing remarkable is here."];
  }
  const idx = rng.nextInt(pool.length);
  return pool[idx];
}

/**
 * Generate a deterministic L2 settlement layout.
 */
function generateL2Settlement(settlement_id, settlement_type, npc_array) {
  const st = SETTLEMENT_SIZES[settlement_type] || SETTLEMENT_SIZES["village"];
  const seed = hashSeedFromLocationID(settlement_id);
  const rng = makeLCG(seed);
  const w = st.width, h = st.height;
  const grid = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      row.push(null);
    }
    grid.push(row);
  }

  // streets: plus sign
  const midY = Math.floor(h / 2);
  const midX = Math.floor(w / 2);
  const streets = [];
  for (let x = 0; x < w; x++) {
    grid[midY][x] = { type: "street", npc_ids: [] };
    streets.push({ x, y: midY });
  }
  for (let y = 0; y < h; y++) {
    if (!grid[y][midX]) grid[y][midX] = { type: "street", npc_ids: [] };
    streets.push({ x: midX, y });
  }

  // buildings
  const buildings = {};
  const buildingCount = st.buildings;
  const buildingNamesByPurpose = {
    tavern: ["The Wanderer's Rest", "The Drunk Griffin", "The Ale House"],
    house: ["Homestead", "Cottage", "Dwelling", "Residence"],
    shop: ["General Store", "Trading Post", "Stall"],
    guildhall: ["Guild Hall", "Council House"],
    temple: ["Temple of Light", "Sacred Shrine"],
    palace: ["The Grand Palace", "Royal Keep"]
  };
  const possiblePurposes = ["house", "house", "shop", "tavern", "house", "temple", "guildhall"];
  for (let i = 0; i < buildingCount; i++) {
    // pick a non-street cell
    let bx = 0, by = 0, tries = 0;
    do {
      bx = rng.nextInt(w);
      by = rng.nextInt(h);
      tries++;
      if (tries > 200) break;
    } while (grid[by][bx] && grid[by][bx].type === "street");
    const purpose = possiblePurposes[rng.nextInt(possiblePurposes.length)];
    const namePool = buildingNamesByPurpose[purpose] || ["Building"];
    const name = namePool[rng.nextInt(namePool.length)];
    const bld_id = `bld_${i}`;
    grid[by][bx] = { type: "building", building_id: bld_id, npc_ids: [] };
    buildings[bld_id] = {
      name,
      purpose,
      tier: st.tier,
      x: bx,
      y: by,
      width: 1,
      height: 1,
      npc_ids: []
    };
  }

  // distribute NPCs
  const npcs = Array.isArray(npc_array) ? npc_array : [];
  const streetSlots = streets.length || 1;
  const total = npcs.length;
  const streetTarget = Math.floor(total * 0.7);
  let streetAssigned = 0;
  // 70% to streets
  for (let i = 0; i < npcs.length && streetAssigned < streetTarget; i++) {
    const npc = npcs[i];
    const slot = streets[streetAssigned % streetSlots];
    const cell = grid[slot.y][slot.x];
    if (cell && cell.type === "street") {
      cell.npc_ids.push(npc.id || npc);
    }
    streetAssigned++;
  }
  // remaining to buildings round-robin
  const bldKeys = Object.keys(buildings);
  let bldIdx = 0;
  for (let i = streetAssigned; i < npcs.length; i++) {
    const npc = npcs[i];
    if (!bldKeys.length) break;
    const key = bldKeys[bldIdx % bldKeys.length];
    buildings[key].npc_ids.push(npc.id || npc);
    bldIdx++;
  }

  return {
    settlement_id,
    type: settlement_type,
    width: w,
    height: h,
    grid,
    buildings,
    streets,
    npcs_on_streets: streets
      .map(s => {
        const cell = grid[s.y][s.x];
        return cell && Array.isArray(cell.npc_ids) ? cell.npc_ids : [];
      })
      .flat()
  };
}

/**
 * Generate a deterministic L2 POI.
 */
function generateL2POI(poi_id, poi_type) {
  const ps = POI_SIZES[poi_type] || POI_SIZES["structure"];
  const seed = hashSeedFromLocationID(poi_id);
  const rng = makeLCG(seed);
  const w = ps.width, h = ps.height;
  const grid = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      row.push({ type: "floor", hazard: null });
    }
    grid.push(row);
  }
  // sprinkle 0-2 hazards
  const hazardTypes = ["water", "collapse", "gas"];
  const hazardCount = rng.nextInt(3);
  const hazards = [];
  for (let i = 0; i < hazardCount; i++) {
    const hx = rng.nextInt(w), hy = rng.nextInt(h);
    const hz = hazardTypes[rng.nextInt(hazardTypes.length)];
    grid[hy][hx].hazard = hz;
    hazards.push({ x: hx, y: hy, type: hz });
  }
  // description
  const poiDescs = {
    cave: [
      "A limestone grotto with crystal formations.",
      "A damp cave with echoes and dripping water."
    ],
    ruin: [
      "Broken pillars and fallen arches lie scattered about.",
      "An overgrown ruin, choked with roots and debris."
    ],
    structure: [
      "A small outbuilding stands here, intact but weathered.",
      "A lonely structure, clearly of recent construction."
    ]
  };
  const pool = poiDescs[poi_type] || ["An unremarkable site."];
  const description = pool[rng.nextInt(pool.length)];

  return {
    poi_id,
    type: poi_type,
    width: w,
    height: h,
    description,
    grid,
    hazards,
    npcs: []
  };
}

/**
 * Generate a deterministic L3 building interior.
 */
function generateL3Building(building_id, building_data) {
  const seed = hashSeedFromLocationID(building_id);
  const rng = makeLCG(seed);
  const purpose = building_data && building_data.purpose ? building_data.purpose : "house";
  const tier = building_data && building_data.tier ? building_data.tier : "humble";
  const npc_ids = (building_data && Array.isArray(building_data.npc_ids)) ? building_data.npc_ids : [];
  const purposeRooms = {
    house: [1, 2],
    shop: [2, 3],
    tavern: [3, 4],
    temple: [3, 5],
    guildhall: [5, 7],
    palace: [6, 8]
  };
  const range = purposeRooms[purpose] || [1, 2];
  const roomCount = range[0] + (rng.nextInt(range[1] - range[0] + 1));
  const ROOM_NAMES = [
    "Taproom","Kitchen","Storage","Bedroom","Office","Hall",
    "Sanctuary","Chamber","Treasury","Cellar","Attic","Study"
  ];
  const rooms = [];
  for (let i = 0; i < roomCount; i++) {
    const rn = ROOM_NAMES[rng.nextInt(ROOM_NAMES.length)];
    const desc = `A ${rn.toLowerCase()} within the ${purpose}.`;
    rooms.push({
      id: `room_${i}`,
      name: rn,
      description: desc,
      npc_ids: [],
      exits: {}
    });
  }
  // connect rooms as a simple chain/tree
  for (let i = 1; i < rooms.length; i++) {
    rooms[i-1].exits[`to_${rooms[i].id}`] = rooms[i].id;
    rooms[i].exits[`to_${rooms[i-1].id}`] = rooms[i-1].id;
  }
  // assign NPCs round-robin
  for (let i = 0; i < npc_ids.length; i++) {
    const r = rooms[i % rooms.length];
    r.npc_ids.push(npc_ids[i]);
  }
  const name = building_data && building_data.name ? building_data.name : "Building";
  const description = `An interior of a ${purpose}, kept at a ${tier} standard.`;
  return {
    building_id,
    name,
    purpose,
    description,
    rooms
  };
}

module.exports = { worldGenStep, exposeSitesInWindow, hydrateCell, generateL1FeatureDescription, generateL2Settlement, generateL2POI, generateL3Building, hashSeedFromLocationID, makeLCG };