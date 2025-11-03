const path = require('path');
const express = require('express');
const axios = require('axios');
const Engine = require('./Engine.js');
const WorldGen = require('./WorldGen.js');
const Actions = require('./ActionProcessor.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

function mapActionToInput(action, kind = "FREEFORM") {
  return {
    player_intent: {
      kind: kind,
      raw: String(action)
    },
    meta: {
      source: "frontend",
      ts: new Date().toISOString()
    }
  };
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
      state: gameState,
      restart: true
    });
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
        state: gameState 
      });
    }
  }

  // Ongoing turn: infer MOVE vs FREEFORM and call Engine
  try {
    if (!Engine.buildOutput) {
      throw new Error('Engine.buildOutput is not a function');
    }
    const parsed = Actions.parseIntent(action);
    const inferredKind = (parsed && parsed.action === "move") ? "MOVE" : "FREEFORM";
    const inputObj = mapActionToInput(action, inferredKind);
    if (parsed && parsed.action === "move" && parsed.dir) {
      inputObj.player_intent.dir = parsed.dir;
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
      state: gameState 
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
    });
  }

  try {
    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: `- Translate engine output (terrain types, cell descriptions, entity lists) into vivid, coherent prose
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
- Narrate ONLY what the player can see based on current location and adjacent areas
- Do NOT invent dungeons, doors, or architecture not mentioned above
- Do NOT reference locations you weren't provided
- If the player input is in parentheses (OOC), break character immediately. Answer technical questions about game state, engine behavior, or narration logic directly and clearly. Do not roleplay.
- Write two full paragraphs of immersive description.`
      }],
      temperature: 0.7
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const narrative = response.data.choices[0].message.content;
    return res.json({ narrative, state: gameState, engine_output: engineOutput, scene });
  } catch (err) {
    console.error('DeepSeek error:', err.message);
    return res.json({ 
      narrative: "The engine processes your action.",
      state: gameState,
      engine_output: engineOutput,
      scene,
      error: err.message
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
