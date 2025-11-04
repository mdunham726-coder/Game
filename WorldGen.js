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


const TERRAIN_TYPES = {
  geography: [
    "plains_grassland", "plains_wildflower", "forest_deciduous", "forest_coniferous", 
    "forest_mixed", "meadow", "hills_rolling", "hills_rocky", "desert_sand", 
    "desert_dunes", "desert_rocky", "scrubland", "badlands", "canyon", "mesa",
    "tundra", "snowfield", "ice_sheet", "permafrost", "alpine", "swamp", "marsh",
    "wetland", "bog", "beach_sand", "beach_pebble", "cliffs_coastal", "tidepools",
    "dunes_coastal", "mountain_slopes", "mountain_peak", "mountain_pass", 
    "rocky_terrain", "scree", "river_crossing", "stream", "lake_shore", 
    "waterfall", "spring"
  ],
  settlement: [
    "campsite", "outpost", "hamlet", "village", "town", "city", "metropolis",
    "fort", "stronghold", "port", "harbor", "trading_post", "mining_camp",
    "logging_camp", "monastery", "temple_complex", "ruins_settlement"
  ],
  poi: [
    "cave_natural", "cavern_crystal", "grotto", "sinkhole", "hot_spring",
    "geyser_field", "ancient_tree", "fairy_ring", "tar_pit", "quicksand",
    "mesa_flat", "rock_formation", "natural_arch", "ruins_temple", "ruins_tower",
    "ruins_castle", "burial_mound", "crypt", "tomb", "standing_stones",
    "stone_circle", "obelisk", "abandoned_mine", "abandoned_mill", "abandoned_bridge",
    "battlefield_old", "shipwreck", "monster_lair", "dragon_cave", "giant_nest",
    "bandit_camp", "cultist_shrine", "witch_hut", "necromancer_tower", "haunted_grove",
    "cursed_ground", "execution_site", "quarry_active", "quarry_abandoned",
    "mine_entrance", "ore_vein", "herb_garden_wild", "berry_grove", "mushroom_circle",
    "fishing_spot", "salt_flat", "clay_pit", "meteor_crater", "portal_remnant",
    "ley_line_nexus", "time_distortion", "crystallized_magic", "petrified_forest",
    "floating_rocks", "gravity_anomaly"
  ]
};

// Keyword matching for world descriptions (9 simple biomes)
const BIOME_KEYWORDS = {
  urban: ["city", "town", "urban", "street", "building", "taco bell", "store", "shop", "modern", "2025", "2024", "mall", "apartment"],
  rural: ["farm", "village", "countryside", "pastoral", "field", "barn", "cottage", "hamlet", "ranch"],
  forest: ["forest", "woods", "trees", "grove", "woodland", "timber"],
  desert: ["desert", "sand", "dunes", "dry", "arid", "scorching", "wasteland", "barren", "sahara"],
  tundra: ["snow", "ice", "arctic", "frozen", "tundra", "glacier", "winter", "cold"],
  jungle: ["jungle", "rainforest", "tropical", "humid", "vines", "exotic", "canopy"],
  coast: ["beach", "ocean", "coast", "port", "harbor", "shore", "sea", "waves", "surf"],
  mountain: ["mountain", "peak", "alpine", "cliff", "summit", "highland", "elevation"],
  wetland: ["swamp", "marsh", "bog", "wetland", "murky", "mire"]
};

// Terrain palettes for each biome
const BIOME_PALETTES = {
  urban: ["plains_grassland", "meadow", "hills_rolling", "scrubland", "river_crossing", "stream"],
  rural: ["plains_grassland", "plains_wildflower", "meadow", "forest_deciduous", "hills_rolling", "river_crossing", "stream"],
  forest: ["forest_deciduous", "forest_mixed", "forest_coniferous", "meadow", "stream", "hills_rolling"],
  desert: ["desert_sand", "desert_dunes", "desert_rocky", "scrubland", "badlands", "canyon", "mesa"],
  tundra: ["tundra", "snowfield", "ice_sheet", "permafrost", "alpine"],
  jungle: ["forest_coniferous", "meadow", "swamp", "marsh", "river_crossing", "stream", "wetland"],
  coast: ["beach_sand", "beach_pebble", "cliffs_coastal", "tidepools", "dunes_coastal", "scrubland", "plains_grassland"],
  mountain: ["mountain_slopes", "mountain_peak", "mountain_pass", "rocky_terrain", "scree", "alpine", "hills_rocky"],
  wetland: ["swamp", "marsh", "wetland", "bog", "stream", "river_crossing"]
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
/**
 * CELL KEY FORMAT (standardized)
 * L1:${mx},${my}:${lx},${ly}
 * mx,my = macro (L0) coords; lx,ly = local (L1) coords.
 */
function byKey(mx, my, lx, ly) {
  const imx = Math.floor(mx|0), imy = Math.floor(my|0);
  const ilx = Math.floor(lx|0), ily = Math.floor(ly|0);
  return `L1:${imx},${imy}:${ilx},${ily}`;
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


function pickTerrainType(seed, mx, my, lx, ly, state) {
  // Check if world has a macro biome set
  let types = TERRAIN_TYPES.geography;
  
  if (state && state.world && state.world.macro_biome) {
    const palette = BIOME_PALETTES[state.world.macro_biome];
    if (palette && palette.length > 0) {
      types = palette;
    }
  }
  
  // Deterministic pick from palette
  const cellSeed = h32(`${seed}|terrain|${mx}|${my}|${lx}|${ly}`);
  const rng = mulberry32(cellSeed);
  const idx = Math.floor(rng() * types.length);
  
  return { 
    type: "geography", 
    subtype: types[idx] 
  };
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
      const terrain = pickTerrainType(state.rng_seed || 0, pos.mx, pos.my, lx, ly, state);
const desc = generateL1FeatureDescription({ type: terrain.type, subtype: terrain.subtype, mx: pos.mx, my: pos.my, lx, ly });
c = state.world.cells[id] = { id, mx: pos.mx, my: pos.my, lx, ly, type: terrain.type, subtype: terrain.subtype, description: desc, known: true, hydrated: !!hydrated, tags: {} };
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
  normalizeCellKeys(state);
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

/**
 * Generate a short narrative description for an L1 cell.
 * Deterministic from provided seed or derived from coords.
 */
function generateL1FeatureDescription(l1_cell_data) {
  if (!l1_cell_data) return "unknown";
  const type = l1_cell_data.type || "geography";
  const subtype = l1_cell_data.subtype || "default";
  return `${type}/${subtype}`;
}

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


// --- Custom World Flagging ---
function flagCustomWorld(state) {
  try {
    if (state?.world?.cells) {
      for (const c of Object.values(state.world.cells)) c.is_custom = true;
    }
    if (Array.isArray(state?.world?.npcs)) {
      for (const n of state.world.npcs) n.is_custom = true;
    }
    if (state?.world?.l2_active) state.world.l2_active.is_custom = true;
    if (state?.world?.l3_active) state.world.l3_active.is_custom = true;
  } catch (e) {
    // non-fatal
  }
}

/**
 * Generate/interpret a world from a natural-language description.
 * This implementation uses existing state and stamps custom flags so that
 * Engine auto-description won't overwrite authored content.
 */
function generateWorldFromDescription(state, description) {
  const desc = String(description || '').toLowerCase();
  
  // Parse keywords to determine biome
  let bestBiome = null;
  let maxMatches = 0;
  
  for (const [biome, keywords] of Object.entries(BIOME_KEYWORDS)) {
    const matches = keywords.filter(kw => desc.includes(kw)).length;
    if (matches > maxMatches) {
      maxMatches = matches;
      bestBiome = biome;
    }
  }
  
  // Default to rural if no keywords match
  if (!bestBiome || maxMatches === 0) {
    bestBiome = "rural";
  }
  
  // Store the chosen biome and original prompt
  const next = { ...state };
  next.world = next.world || {};
  next.world.macro_biome = bestBiome;
  next.world.world_prompt = String(description);
  
  // Generate seed from description for determinism
  const seed = next.world.seed || h32(description);
  next.world.seed = seed;
  
  return next;
}
function normalizeCellKeys(state) {
  const cells = state?.world?.cells;
  if (!cells || typeof cells !== 'object') return;
  for (const [k, cell] of Object.entries(cells)) {
    if (!cell || typeof cell !== 'object') continue;
    const want = byKey(cell.mx, cell.my, cell.lx, cell.ly);
    if (k !== want) {
      delete cells[k];
      cells[want] = { ...cell, id: want };
    }
  }
}

module.exports = { generateWorldFromDescription,  worldGenStep, exposeSitesInWindow, generateL1FeatureDescription, generateL2Settlement, generateL2POI, generateL3Building, hashSeedFromLocationID, makeLCG };