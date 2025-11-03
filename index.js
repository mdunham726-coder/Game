const path = require('path');
const express = require('express');
const axios = require('axios');
const Engine = require('./Engine.js');
const WorldGen = require('./WorldGen.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let gameState = null;
let isFirstTurn = true;

function initializeGame() {
  let state = null;
  if (Engine && typeof Engine.initState === 'function') {
    state = Engine.initState();
  } else {
    state = {
      player: { mx: 0, my: 0, layer: 1, inventory: [] },
      world: { npcs: [], cells: {}, l2_active: null, l3_active: null, current_layer: 1 }
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

app.get('/init', (req, res) => {
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
  const actionLower = action.toLowerCase();
  if (restartKeywords.some(kw => actionLower.includes(kw))) {
    const init = initializeGame();
    gameState = init.state;
    return res.json({
      narrative: "Describe your world in 3 sentences.",
      state: gameState,
      restart: true
    });
  }
  const beforeCells = Object.keys(gameState?.world?.cells || {}).length;
  console.log('[turn] cells_before=', beforeCells);

  if (isFirstTurn === true) {
    isFirstTurn = false;
    return res.json({
      narrative: action,
      state: gameState,
      engine_output: null
    });
  }
  let engineOutput = null;
try {
  if (!Engine.buildOutput) {
    throw new Error('Engine.buildOutput is not a function');
  }
  engineOutput = Engine.buildOutput(gameState, {
  timestamp_utc: new Date().toISOString(),
  player_intent: action,
  turn_id: `turn_${Date.now()}`
});
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
  const afterCells = Object.keys(gameState?.world?.cells || {}).length;
  console.log('[turn] cells_after=', afterCells);

  const scene = {
    playerLocation: gameState.player?.mx || 'unknown',
    playerLayer: gameState.player?.layer || 0,
    playerInventory: gameState.player?.inventory || [],
    npcs: (gameState.world?.npcs || []).filter(n => n.location === gameState.player?.mx),
    engineDeltas: engineOutput?.deltas || []
  };
  if (!process.env.DEEPSEEK_API_KEY) {
    return res.json({ 
      error: 'DEEPSEEK_API_KEY not set',
      narrative: "The engine processes your action.",
      state: gameState,
      engine_output: engineOutput
    });
  }
  try {
    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: `You are a dungeon master narrating a roguelike adventure.

Current world state:
- Player location: ${scene.playerLocation}
- Player layer: ${scene.playerLayer}
- Inventory: ${JSON.stringify(scene.playerInventory)}
- NPCs nearby: ${JSON.stringify(scene.npcs)}

Player action: "${action}"

Narrate what happens next in 2-3 sentences, grounded in the actual game state.`
      }],
      max_tokens: 300,
      temperature: 0.8
    }, {
      headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` }
    });
    const narrative = response.data.choices[0].message.content;
    return res.json({ narrative, state: gameState, engine_output: engineOutput });
  } catch (err) {
    console.error('DeepSeek error:', err.message);
    return res.json({ 
      narrative: "The engine processes your action.",
      state: gameState,
      engine_output: engineOutput,
      error: err.message
    });
  }
});

app.post('/reset', (req, res) => {
  gameState = null;
  isFirstTurn = true;
  const result = initializeGame();
  return res.json(result);
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
