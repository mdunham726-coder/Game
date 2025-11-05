// ActionProcessor.js — extracted from v103-1/v118 (no refactors; same behavior)
const crypto = require('crypto');

// Keep defaults for consistency (not used heavily here but stable)
const DEFAULTS = {
  STREAM: { R: 2, P: 1 },
};

function sha256Hex(s) { return crypto.createHash('sha256').update(String(s),'utf8').digest('hex'); }
function parseISO(ts) { const d=new Date(ts); if (Number.isNaN(d.getTime())) throw new Error("INVALID_ISO_TIMESTAMP"); return d; }
function toISO(d) { return new Date(d).toISOString(); }

// Levenshtein + alias score (matching v118)
function levenshtein(a,b){
  a = String(a||'').toLowerCase(); b = String(b||'').toLowerCase();
  const n = a.length, m = b.length;
  const dp = new Array(m+1);
  for (let j=0;j<=m;j++) dp[j] = j;
  for (let i=1;i<=n;i++){
    let prev = dp[0];
    dp[0] = i;
    for (let j=1;j<=m;j++){
      const tmp = dp[j];
      const cost = (a[i-1]===b[j-1]) ? 0 : 1;
      dp[j] = Math.min(dp[j]+1, dp[j-1]+1, prev+cost);
      prev = tmp;
    }
  }
  return dp[m];
}
function aliasScore(query, name, aliases, ctxBonus=0){
  const q = String(query||'').trim().toLowerCase();
  let score = 0;
  if (q === String(name||'').trim().toLowerCase()) score += 10;
  if (Array.isArray(aliases) && aliases.some(al => q === String(al||'').trim().toLowerCase())) score += 6;
  const dists = [levenshtein(q, String(name||''))];
  if (Array.isArray(aliases)) for (const al of aliases) dists.push(levenshtein(q, String(al||'')));
  const dist = Math.min(...dists);
  if (dist > 2) score -= 2;
  score += Math.max(0, Math.min(ctxBonus, 4));
  return score;
}
function resolveItemByName(state, query){
  const inv = (((state||{}).player||{}).inventory)||[];
  const cands = [];
  for (const it of inv){
    const sc = aliasScore(query, it?.name||'', it?.aliases||[], 2);
    cands.push([sc, 'inventory', it]);
  }
  if (!cands.length) return null;
  cands.sort((a,b)=>b[0]-a[0]);
  const best = cands[0];
  const second = cands[1] || [-9999,'',{}];
  if (best[0] >= 20 && (best[0] - (typeof second[0]==='number'?second[0]:-9999)) >= 10){
    return [best[1], best[2]];
  }
  return null;
}

// Intent parsing (as in v118)
/* LEGACY FALLBACK — deprecated; used only if SemanticParser fails */
function parseIntent(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^(look|look around|observe|scan)$/.test(t)) return { action:'look' };
  let m;
  m = t.match(/^\b(grab|take|pick up)\b\s+(.*)$/); if (m){
    let target = (m[2]||'').trim().replace(/^(the|a|an)\s+/, '');
    if (!target) return { action:'noop' };
    return { action:'take', target };
  }
  m = t.match(/^\b(drop)\b\s+(.*)$/); if (m){
    let target = (m[2]||'').trim().replace(/^(the|a|an)\s+/, '');
    if (!target) return { action:'noop' };
    return { action:'drop', target };
  }
  // movement parsing moved to WorldGen.parseAndApplyMovement
}

// Expiry tick + regen + player actions (take/drop/look)
// (movement handled by WorldGen; we still parse it so Engine can route)


function applyPlayerActions(state, actions, deltas, flags){
  const act = actions?.action;
  if (act === 'take'){ return; }
  if (act === 'drop'){
    const target = actions?.target||'';
    const res = resolveItemByName(state, target);
    if (res && res[0] === 'inventory'){
      const item = res[1];
      const inv = state.player.inventory;
      const idx = inv.findIndex(it => (it?.id) === item?.id);
      if (idx >= 0){
        inv.splice(idx,1);
        deltas.push({ op:'set', path:'/player/inventory', value: inv });
        flags.inventory_rev = true;
      }
    }
    return;
  }
  if (act === 'look'){ return; }
}

function computeInventoryDigestHex(state){
  const inv = (((state||{}).player||{}).inventory)||[];
  const rows = inv.map(it => {
    const slot = ((it||{}).props||{}).slot || '';
    const rarity = ((it||{}).props||{}).rarity || '';
    const line = `${it?.id||''}|${it?.name||''}|${slot}|${rarity}|${it?.property_revision||0}`;
    return line;
  }).sort().join('\n');
  return sha256Hex(rows);
}

// === Phase 3: Validation for pre-normalized intents (no state mutation) ===
const DIR_ALIASES = { n:'north', s:'south', e:'east', w:'west', u:'up', d:'down' };
const VALID_DIRS = new Set(['north','south','east','west','up','down']);

function isValidDir(dir){
  if (!dir) return { ok:false, canonical:null };
  const d = String(dir).trim().toLowerCase();
  const canon = DIR_ALIASES[d] || d;
  return { ok: VALID_DIRS.has(canon), canonical: VALID_DIRS.has(canon) ? canon : null };
}

function getCellEntities(state){
  const cell = (((state||{}).world||{}).current_cell)||{};
  const items = Array.isArray(cell.items) ? cell.items : [];
  // If your schema nests npcs per cell, prefer that. Otherwise fallback to world.npcs array.
  const npcs = Array.isArray((((state||{}).world)||{}).npcs) ? state.world.npcs : (Array.isArray(cell.npcs)?cell.npcs:[]);
  return { items, npcs };
}

function findByNameCaseInsensitive(list, prop, query){
  const q = String(query||'').trim().toLowerCase();
  for (const it of (list||[])){
    const name = String(it?.[prop]||'').toLowerCase();
    if (name === q) return it;
  }
  return null;
}

function resolveCellItemByName(state, query){
  const { items } = getCellEntities(state);
  // Prefer aliasScore if available (matching inventory resolver style)
  let best = null;
  let bestScore = -1e9;
  for (const it of items){
    const score = (typeof aliasScore === 'function')
      ? aliasScore(query, it?.name||'', it?.aliases||[], 2)
      : (String(it?.name||'').toLowerCase() === String(query||'').trim().toLowerCase() ? 10 : 0);
    if (score > bestScore){ bestScore = score; best = it; }
  }
  return bestScore >= 6 ? best : null; // threshold similar to inventory resolver
}

function hasInventoryItem(state, name){
  const inv = (((state||{}).player||{}).inventory)||[];
  return !!findByNameCaseInsensitive(inv, 'name', name);
}

function isNPCPresent(state, name){
  const { npcs } = getCellEntities(state);
  return !!findByNameCaseInsensitive(npcs, 'name', name);
}

/**
 * validateAndQueueIntent(gameState, normalizedIntent)
 * Returns: { valid, queue, reason?, stateValidation? }
 */
function validateAndQueueIntent(state, normalizedIntent){
  const sv = { hasPlayer: !!((state||{}).player), notes: [] };

  if (!normalizedIntent || typeof normalizedIntent !== 'object'){
    return { valid:false, queue:[], reason:"NO_INTENT", stateValidation:sv };
  }
  const primary = normalizedIntent.primaryAction || null;
  if (!primary || typeof primary.action !== 'string' || !primary.action.trim()){
    return { valid:false, queue:[], reason:"NO_PRIMARY_ACTION", stateValidation:sv };
  }
  const secondaries = Array.isArray(normalizedIntent.secondaryActions) ? normalizedIntent.secondaryActions : [];
  const queue = normalizedIntent.compound ? [primary, ...secondaries] : [primary];

  // Validate each queued action without mutating state
  for (const act of queue){
    const action = String(act?.action||'').toLowerCase();
    if (!action){ return { valid:false, queue:[], reason:"EMPTY_ACTION", stateValidation:sv }; }

    if (action === 'move'){
      const { ok, canonical } = isValidDir(act?.dir);
      sv.validDir = ok;
      if (!ok) return { valid:false, queue:[], reason:"INVALID_DIRECTION", stateValidation:sv };
      act.dir = canonical; // canonicalize
      continue;
    }

    if (action === 'take'){
      const target = act?.target||'';
      const found = resolveCellItemByName(state, target);
      sv.targetInCell = !!found;
      if (!found) return { valid:false, queue:[], reason:"TARGET_NOT_FOUND_IN_CELL", stateValidation:sv };
      continue;
    }

    if (action === 'drop'){
      const target = act?.target||'';
      const inInv = hasInventoryItem(state, target);
      sv.targetInInventory = inInv;
      if (!inInv) return { valid:false, queue:[], reason:"TARGET_NOT_IN_INVENTORY", stateValidation:sv };
      continue;
    }

    if (action === 'examine'){
      const t = act?.target||'';
      const inCell = !!resolveCellItemByName(state, t);
      const inInv = hasInventoryItem(state, t);
      const npc   = isNPCPresent(state, t);
      sv.visible = !!(inCell || inInv || npc);
      if (!sv.visible) return { valid:false, queue:[], reason:"TARGET_NOT_VISIBLE", stateValidation:sv };
      continue;
    }

    if (action === 'talk'){
      const t = act?.target||'';
      const present = isNPCPresent(state, t);
      sv.targetIsNPC = present;
      if (!present) return { valid:false, queue:[], reason:"NPC_NOT_PRESENT", stateValidation:sv };
      continue;
    }

    // Lightweight checks / always-allow group
    if (['sit','stand','wait','listen','look','inventory','help'].includes(action)){
      continue;
    }

    // Actions that may need deeper model checks; allow if not modeled here
    if (['cast','attack','sneak'].includes(action)){
      sv.notes.push(`allowed_${action}_shallow`);
      continue;
    }

    // Unknown action: pass through but mark as shallow-validated
    sv.notes.push(`unknown_action:${action}`);
  }

  console.log('[ACTIONS] valid queue=%d primary=%s', queue.length, queue[0]?.action);
  return { valid:true, queue, stateValidation:sv };
}

module.exports = {
  validateAndQueueIntent,
  parseIntent,
  applyPlayerActions,
  computeInventoryDigestHex,
  resolveItemByName,
  isValidDir,
  getCellEntities,
  findByNameCaseInsensitive,
  resolveCellItemByName,
  hasInventoryItem,
  isNPCPresent
};
