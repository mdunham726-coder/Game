const express = require('express');
const WorldGen = require('./WorldGen.v4.patched (1)');
const Engine = require('./Engine.v6.patched (1)');

const app = express();
app.use(express.json());

let state = Engine.initState();

app.get('/status', (req, res) => {
  res.json({ message: 'Roguelike engine running!', layer: state.world.current_layer });
});

app.post('/turn', (req, res) => {
  const action = req.body.action || 'wait';
  const output = Engine.buildOutput(state, action);
  res.json(output);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
