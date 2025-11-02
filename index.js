const express = require('express');
const WorldGen = require('./WorldGen.v4.patched (1)');
const Engine = require('./Engine.v6.patched (1)');
const axios = require('axios');
const path = require('path');
const app = express();
app.use(express.json());
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
        body: JSON.stringify({ action, state: {} })
      });
      const data = await resp.json();
      document.getElementById('output').innerHTML += '<p>' + data.narrative + '</p>';
    }
  </script>
</body>
</html>`);
});
let state = Engine.initState();
app.get('/status', (req, res) => {
  res.json({ message: 'Roguelike engine running!', layer: state.world.current_layer });
});

app.post('/turn', (req, res) => {
  const action = req.body.action || 'wait';
  const output = Engine.buildOutput(state, action);
  res.json(output);
});
app.post('/narrate', async (req, res) => {
  const { action, state } = req.body;
  
  if (!process.env.DEEPSEEK_API_KEY) {
    return res.status(500).json({ error: 'DEEPSEEK_API_KEY not set' });
  }
  
  try {
    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: `You are a dungeon master narrating a fantasy adventure. Here is the current game state:

${JSON.stringify(state, null, 2)}

The player action is: "${action}"

Describe what happens next in 2-3 sentences, keeping it immersive and vivid.`
      }],
      max_tokens: 300,
      temperature: 0.8
    }, {
      headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` }
    });
    
    res.json({ narrative: response.data.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
