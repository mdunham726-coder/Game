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

module.exports = {
  DEFAULTS, parseIntent,
  applyPlayerActions, computeInventoryDigestHex
};
