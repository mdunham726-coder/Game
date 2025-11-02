const express = require('express');
const WorldGen = require('./WorldGen.v4.patched (1)');
const Engine = require('./Engine.v6.patched (1)');
const axios = require('axios');
const app = express();
app.use(express.json());

let gameState = null;

function initializeGame() {
  const world = WorldGen.generateWorld();
  gameState = Engine.initState();
  gameState.world = world;
  return gameState;
}

// Initialize on startup
gameState = initializeGame();

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Roguelike Game</title>
  <style>
    body { background: #1a1a1a; color: #fff; font-family: Arial; padding: 20px; }
    #output { background: #000; padding: 10px; margin: 10px 0; height: 200px; overflow-y: auto; }
    input { width: 80%; padding: 8px; }
    button { padding: 8px 15px; background: #444; color: #fff; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Roguelike Adventure</h1>
  <div id="output">Game starting...</div>
  <input id="action" type="text" placeholder="Enter action...">
  <button onclick="submitAction()">Submit</button>
  <script>
    async function submitAction() {
      const action = document.getElementById('action').value;
      const resp = await fetch('/narrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const data = await resp.json();
      document.getElementById('output').innerHTML += '<p>' + data.narrative + '</p>';
      document.getElementById('action').value = '';
    }
  </script>
</body>
</html>`);
});

app.get('/status', (req, res) => {
  res.json({ message: 'Roguelike engine running!', state: gameState });
});

app.post('/narrate', async (req, res) => {
  const { action } = req.body;
  
  if (!gameState) {
    gameState = initializeGame();
  }
  
  if (!process.env.DEEPSEEK_API_KEY) {
    return res.status(500).json({ error: 'DEEPSEEK_API_KEY not set' });
  }
  
  try {
    // Apply action to game state
    gameState = Engine.buildOutput(gameState, action);
    
    // Send DeepSeek the REAL world state + action
    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: `You are a dungeon master narrating a fantasy adventure. Current game state:

World: ${JSON.stringify(gameState.world, null, 2)}
Player Location: ${gameState.player?.location || 'unknown'}
Nearby NPCs: ${JSON.stringify(gameState.world?.npcs?.filter(n => n.location === gameState.player?.location) || [], null, 2)}
Player Inventory: ${JSON.stringify(gameState.player?.inventory || [], null, 2)}

Player action: "${action}"

Narrate what happens next in 2-3 sentences, considering the actual world state.`
      }],
      max_tokens: 300,
      temperature: 0.8
    }, {
      headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` }
    });
    
    res.json({ 
      narrative: response.data.choices[0].message.content,
      state: gameState 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
