const path = require('path');
const express = require('express');
const axios = require('axios');
const Engine = require('./Engine.js');
// Legacy import retained for compatibility
const Actions = require('./ActionProcessor.js');

const { validateAndQueueIntent, parseIntent } = require('./ActionProcessor_v3.js');
const { normalizeUserIntent } = require('./SemanticParser.js');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

function getActionKind(a) { return (a && a.action === 'move') ? 'MOVE' : 'FREEFORM'; }

function mapActionToInput(action, kind = "FREEFORM") {
  const result = {
    player_intent: {
      kind: kind,
      raw: String(action)
    },
    meta: {
      source: "frontend",
      ts: new Date().toISOString()
    }
  };
  
  // Add top-level WORLD_PROMPT for Engine compatibility
  if (kind === "WORLD_PROMPT") {
    result.WORLD_PROMPT = String(action);
  }
  
  return result;
}

let gameState = null;
let isFirstTurn = true;

function initializeGame() {
  let state = null;
  if (Engine && typeof Engine.initState === 'function') {
    state = Engine.initState();
  } else {
    state = {
      player: { mx: 0, my: 0, layer: 1, inventory: [] },
      world: { npcs: [], cells: {}, l2_active: null, l3_active: null, current_layer: 1, position: { mx:0, my:0, lx:6, ly:6 }, l1_default: { w: 12, h: 12 } }
    };
  }
  gameState = state;
  isFirstTurn = true;
  return {
    status: "world_created",
    state: gameState,
    prompt: "Describe your world in 3 sentences."
  };
}

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'Index.html');
  res.sendFile(htmlPath);
});

app.post('/init', (req, res) => {
  const result = initializeGame();
  return res.json(result);
});

app.post('/reset', (req, res) => {
  gameState = null;
  isFirstTurn = true;
  const result = initializeGame();
  return res.json(result);
});

app.post('/narrate', async (req, res) => {
  const { action } = req.body;
  if (!action) {
    return res.status(400).json({ error: 'action is required' });
  }
  if (gameState === null) {
    const init = initializeGame();
    gameState = init.state;
  }
  const restartKeywords = ["new world", "restart", "begin again"];
  const actionLower = String(action).toLowerCase();
  if (restartKeywords.some(kw => actionLower.includes(kw))) {
    const init = initializeGame();
    gameState = init.state;
    return res.json({
      narrative: "Describe your world in 3 sentences.",
      debug,
      state: gameState,
      restart: true
    });
  // --- Semantic Parser integration (Phase 2) ---
  const userInput = String(action);
  const gameContext = {
    player: gameState?.player ? {
      position: gameState.player,
      inventory: Array.isArray(gameState.player.inventory) ? gameState.player.inventory.map(i => i.name) : []
    } : null,
    current_cell: gameState?.world?.current_cell || null,
    adjacent_cells: gameState?.world?.adjacent_cells || null,
    npcs_present: Array.isArray(gameState?.world?.npcs) ? gameState.world.npcs.map(n => n.name) : []
  };
  let parseResult = null;
  try {
    parseResult = await normalizeUserIntent(userInput, gameContext);
  } catch (e) {
    parseResult = { success: false, error: 'LLM_UNAVAILABLE', intent: null };
    console.warn('[PARSER] exception in semantic parser:', e?.message);
  }
  let debug = {
    parser: "none",
    input: userInput,
    intent: (parseResult && parseResult.intent) ? parseResult.intent : null,
    confidence: (parseResult && typeof parseResult.confidence === 'number') ? parseResult.confidence : 0,
    clarification: null
  };

  }

  // Before-turn debug info
  const beforeCells = Object.keys(gameState?.world?.cells || {}).length;
  console.log('[turn] cells_before=', beforeCells);

  // First turn: seed world using WORLD_PROMPT through Engine
  let engineOutput = null;
  if (isFirstTurn === true) {
    isFirstTurn = false;
    const inputObj = mapActionToInput(action, "WORLD_PROMPT");
    try {
      engineOutput = Engine.buildOutput(gameState, inputObj);
      if (engineOutput && engineOutput.state) {
        gameState = engineOutput.state;
      }
    } catch (err) {
      console.error('Engine error on first turn:', err.message);
      return res.json({ 
        error: `engine_failed: ${err.message}`, 
        narrative: "The engine encountered an error initializing the world.",
        state: gameState,
        debug 
      });
    }
  }
else {

  // Ongoing turn: infer MOVE vs FREEFORM and call Engine
  
  // Semantic parse branching with legacy fallback
  try {
    if (!Engine.buildOutput) {
      throw new Error('Engine.buildOutput is not a function');
    }

    // Clarify if low confidence (only for non-first-turn)
    if (parseResult && parseResult.success === true && typeof parseResult.confidence === 'number' && parseResult.confidence < 0.5) {
      console.log('[PARSER] semantic_clarify input="%s" confidence=%s', userInput, parseResult.confidence);
      debug.parser = "semantic_clarify";
      debug.clarification = "awaiting_confirmation";
      return res.json({
        narrative: `[CLARIFICATION] I didn't quite understand that. Did you mean to: ${parseResult.intent?.primaryAction?.action || '...'}? (yes/no/try again)`,
        state: gameState,
        debug
      });
    }

    let inputObj = null;

    if (parseResult && parseResult.success === true && typeof parseResult.confidence === 'number' && parseResult.confidence >= 0.5) {
      console.log('[PARSER] semantic_ok input="%s" action="%s" confidence=%s', userInput, parseResult.intent?.primaryAction?.action, parseResult.confidence);
      debug.parser = "semantic";
      // Phase 4: validate queue and execute sequentially
      const validation = validateAndQueueIntent(gameState, parseResult.intent);
      if (!validation.valid) {
        return res.json({
          success: true,
          narrative: `Action invalid: ${validation.reason}`,
          state: gameState,
          debug: { ...debug, parser: "semantic", error: "INVALID_ACTION", reason: validation.reason, validation: validation.stateValidation }
        });
      }
      const allResponses = [];
      for (const queuedAction of validation.queue) {
        const raw = [queuedAction.action, queuedAction.target].filter(Boolean).join(' ');
        const mapped = mapActionToInput(raw, getActionKind(queuedAction));
        if (queuedAction.action === 'move' && queuedAction.dir) {
          const dirMap = { north:'n', south:'s', east:'e', west:'w', up:'u', down:'d' };
          const d = String(queuedAction.dir).toLowerCase();
          mapped.player_intent.dir = dirMap[d] || d;
        }
        const result = await Engine.buildOutput(gameState, mapped);
        allResponses.push(result);
        if (result && result.state) gameState = result.state;
      }
      engineOutput = allResponses[allResponses.length - 1];
      debug = { ...debug, parser: "semantic", queue_length: validation.queue.length };
    } else {
      // Fallback to legacy parser
      console.log('[PARSER] fallback_legacy input="%s"', userInput);
      debug.parser = "legacy";
      const parsed = Actions.parseIntent(action);
      const inferredKind = (parsed && parsed.action === "move") ? "MOVE" : "FREEFORM";
      inputObj = mapActionToInput(action, inferredKind);
      if (parsed && parsed.action === "move" && parsed.dir) {
        inputObj.player_intent.dir = parsed.dir;
      }
    }

    engineOutput = Engine.buildOutput(gameState, inputObj);
    if (engineOutput && engineOutput.state) {
      gameState = engineOutput.state;
    }
  } catch (err) {
    console.error('Engine error:', err.message);
    return res.json({ 
      error: `engine_failed: ${err.message}`, 
      narrative: "The engine encountered an error processing your action.",
      state: gameState,
      debug
    });
}
// --- Scene: current cell + nearby cells (N,S,E,W) ---
  const pos = gameState?.world?.position || {};
  const l1w = (gameState?.world?.l1_default?.w) || 12;
  const l1h = (gameState?.world?.l1_default?.h) || 12;
  function clamp(v, min, max){ return Math.max(min, Math.min(max, v)); }
  function cellKey(mx,my,lx,ly){ return `L1:${mx},${my}:${lx},${ly}`; }

  const curKey = cellKey(pos.mx, pos.my, pos.lx, pos.ly);
  const cellsMap = (gameState?.world?.cells) || {};
if (!cellsMap[curKey]) {
  console.warn(`[DEBUG] Cell key mismatch: looking for ${curKey}, cells available:`, Object.keys(cellsMap).slice(0, 5));
}
  const curCellRaw = cellsMap[curKey];

  const currentCell = {
    description: (curCellRaw && curCellRaw.description) || "An empty space",
    type: (curCellRaw && curCellRaw.type) || "void",
    subtype: (curCellRaw && curCellRaw.subtype) || "",
    is_custom: !!(curCellRaw && curCellRaw.is_custom),
    key: curKey
  };

  const deltas = [
    { name: "North", dx: 0, dy: -1 },
    { name: "South", dx: 0, dy:  1 },
    { name: "East",  dx: 1, dy:  0 },
    { name: "West",  dx:-1, dy:  0 }
  ];

  const nearbyCells = deltas.map(d => {
    const lx = clamp((pos.lx || 0) + d.dx, 0, l1w - 1);
    const ly = clamp((pos.ly || 0) + d.dy, 0, l1h - 1);
    const key = cellKey(pos.mx, pos.my, lx, ly);
    const c = cellsMap[key];
    return {
      dir: d.name,
      key,
      description: (c && c.description) || "Unknown",
      type: (c && c.type) || "void",
      subtype: (c && c.subtype) || "",
      is_custom: !!(c && c.is_custom)
    };
  });

  const scene = {
    currentCell,
    nearbyCells,
    worldPosition: gameState?.world?.position || {},
    worldLayer: gameState?.world?.current_layer || 1,
    inventory: gameState?.player?.inventory || [],
    npcs: gameState?.world?.npcs || []
  };

  // After-turn debug info
  const afterCells = Object.keys(gameState?.world?.cells || {}).length;
  console.log('[turn] cells_after=', afterCells);

  if (!process.env.DEEPSEEK_API_KEY) {
    return res.json({ 
      error: 'DEEPSEEK_API_KEY not set',
      narrative: "The engine processes your action.",
      state: gameState,
      engine_output: engineOutput,
      scene
    , debug} );
  }
  console.log('[narrate] scene:', JSON.stringify(scene, null, 2));

  try {
    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: `You are narrating an interactive roguelike game driven by a procedural engine.
- Translate engine output (terrain types, cell descriptions, entity lists) into vivid, coherent prose
- Maintain environmental consistency: terrain types define what the player can see and interact with
- Build narrative tension through descriptions of current terrain and environmental features
- React to player action by describing immediate sensory consequences within the game world

CURRENT LOCATION:
${scene.currentCell.description}
(Terrain: ${scene.currentCell.type}/${scene.currentCell.subtype})

ADJACENT AREAS:
North: ${scene.nearbyCells.find(c => c.dir === 'North')?.description || 'Unknown'}
South: ${scene.nearbyCells.find(c => c.dir === 'South')?.description || 'Unknown'}
East: ${scene.nearbyCells.find(c => c.dir === 'East')?.description || 'Unknown'}
West: ${scene.nearbyCells.find(c => c.dir === 'West')?.description || 'Unknown'}

INVENTORY: ${JSON.stringify(scene.inventory)}
NPCs PRESENT: ${scene.npcs && scene.npcs.length > 0 ? JSON.stringify(scene.npcs) : 'None'}

Player action: "${action}"

CONSTRAINTS:
- If the player input is in parentheses (OOC), break character immediately and answer their technical question directly
- Narrate ONLY what the player can see based on current location and adjacent areas
- Do NOT invent dungeons, doors, or architecture not mentioned above
- Do NOT reference locations you weren't provided
- Write a full paragraph of immersive description

DEBUG_FOOTER:
At the end of your narration, append this metadata block:
---DEBUG---
current_cell: ${scene.currentCell.type}/${scene.currentCell.subtype}
cell_description: ${scene.currentCell.description.substring(0, 50)}...
adjacent_cells: [${scene.nearbyCells.map(c => c.dir + ':' + c.type).join(', ')}]
npcs_count: ${scene.npcs.length}
inventory_count: ${scene.inventory.length}
---END_DEBUG---`
      }],
      temperature: 0.7
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const narrative = response.data.choices[0].message.content;
    return res.json({ narrative, state: gameState, engine_output: engineOutput, scene , debug} );
  } catch (err) {
    console.error('DeepSeek error:', err.message);
    return res.json({ 
      narrative: "The engine processes your action.",
      state: gameState,
      engine_output: engineOutput,
      scene,
      error: err.message
    , debug} );
  }
}s_after=', afterCells);

  if (!process.env.DEEPSEEK_API_KEY) {
    return res.json({ 
      error: 'DEEPSEEK_API_KEY not set',
      narrative: "The engine processes your action.",
      state: gameState,
      engine_output: engineOutput,
      scene
    });
  }
  console.log('[narrate] scene:', JSON.stringify(scene, null, 2));

  try {
    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: `You are narrating an interactive roguelike game driven by a procedural engine.
- Translate engine output (terrain types, cell descriptions, entity lists) into vivid, coherent prose
- Maintain environmental consistency: terrain types define what the player can see and interact with
- Build narrative tension through descriptions of current terrain and environmental features
- React to player action by describing immediate sensory consequences within the game world

CURRENT LOCATION:
${scene.currentCell.description}
(Terrain: ${scene.currentCell.type}/${scene.currentCell.subtype})

ADJACENT AREAS:
North: ${scene.nearbyCells.find(c => c.dir === 'North')?.description || 'Unknown'}
South: ${scene.nearbyCells.find(c => c.dir === 'South')?.description || 'Unknown'}
East: ${scene.nearbyCells.find(c => c.dir === 'East')?.description || 'Unknown'}
West: ${scene.nearbyCells.find(c => c.dir === 'West')?.description || 'Unknown'}

INVENTORY: ${JSON.stringify(scene.inventory)}
NPCs PRESENT: ${scene.npcs && scene.npcs.length > 0 ? JSON.stringify(scene.npcs) : 'None'}

Player action: "${action}"

CONSTRAINTS:
- If the player input is in parentheses (OOC), break character immediately and answer their technical question directly
- Narrate ONLY what the player can see based on current location and adjacent areas
- Do NOT invent dungeons, doors, or architecture not mentioned above
- Do NOT reference locations you weren't provided
- Write a full paragraph of immersive description

DEBUG_FOOTER:
At the end of your narration, append this metadata block:
---DEBUG---
current_cell: ${scene.currentCell.type}/${scene.currentCell.subtype}
cell_description: ${scene.currentCell.description.substring(0, 50)}...
adjacent_cells: [${scene.nearbyCells.map(c => c.dir + ':' + c.type).join(', ')}]
npcs_count: ${scene.npcs.length}
inventory_count: ${scene.inventory.length}
---END_DEBUG---`
      }],
      temperature: 0.7
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const narrative = response.data.choices[0].message.content;
    return res.json({ narrative, state: gameState, engine_output: engineOutput, scene, debug });
  } catch (err) {
    console.error('DeepSeek error:', err.message);
    return res.json({ 
      narrative: "The engine processes your action.",
      state: gameState,
      engine_output: engineOutput,
      scene,
      error: err.message,
      debug
    });
  }
});

app.get('/status', (req, res) => {
  return res.json({
    status: 'running',
    hasGameState: gameState !== null,
    isFirstTurn: isFirstTurn,
    playerLocation: gameState?.player?.mx || null
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}
`);
});
