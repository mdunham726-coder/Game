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

// Initialize a new game world
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

// GET / - Serve the HTML
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'Index.html');
  res.sendFile(htmlPath);
});

// GET /init - Initialize a new game
app.get('/init', (req, res) => {
  const result = initializeGame();
  return res.json(result);
});

// POST /narrate - Process player action
app.post('/narrate', async (req, res) => {
  const { action } = req.body;
  
  if (!action) {
    return res.status(400).json({ error: 'action is required' });
  }
  
  // Guard: Initialize if null
  if (gameState === null) {
    const init = initializeGame();
    gameState = init.state;
  }
  
  // Check for restart keywords
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
  
  // First-turn override: always prompt for world description on first action
  if (isFirstTurn === true) {
    isFirstTurn = false;
    return res.json({
      narrative: "Describe your world in 3 sentences.",
      state: gameState,
      engine_output: null
    });
  }
  
  // Call Engine to process action
  let engineOutput = null;
  try {
    engineOutput = Engine.buildOutput(gameState, action);
    
    // If buildOutput returns a new state, reassign; otherwise assume mutation in place
    if (engineOutput && engineOutput.state) {
      gameState = engineOutput.state;
    }
  } catch (err) {
    console.error('Engine error:', err.message);
    return res.json({ 
      error: "engine_failed", 
      details: err.message,
      state: gameState 
    });
  }
  
  // Extract scene data from gameState
  const scene = {
    playerLocation: gameState.player?.mx || 'unknown',
    playerLayer: gameState.player?.layer || 0,
    playerInventory: gameState.player?.inventory || [],
    npcs: (gameState.world?.npcs || []).filter(n => 
      n.location === gameState.player?.mx
    ),
    engineDeltas: engineOutput?.deltas || []
  };
  
  // Call DeepSeek for narration
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
    return res.json({ 
      narrative, 
      state: gameState, 
      engine_output: engineOutput 
    });
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

// POST /reset - Reset the game
app.post('/reset', (req, res) => {
  gameState = null;
  isFirstTurn = true;
  const result = initializeGame();
  return res.json(result);
});

// GET /status - Debug endpoint
app.get('/status', (req, res) => {
  return res.json({
    status: 'running',
    hasGameState: gameState !== null,
    isFirstTurn: isFirstTurn,
    playerLocation: gameState?.player?.mx || null
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
