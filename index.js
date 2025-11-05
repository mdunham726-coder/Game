const path = require('path');
const express = require('express');
const axios = require('axios');
const Engine = require('./Engine.js');
// Legacy import retained for compatibility
const Actions = require('./ActionProcessor.js');

const { validateAndQueueIntent, parseIntent } = require('./ActionProcessor.js');
const { normalizeUserIntent } = require('./SemanticParser.js');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Session state management
const sessionStates = new Map();

function generateSessionId() {
  return Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

function getSessionState(sessionId) {
  if (!sessionId || !sessionStates.has(sessionId)) {
    const newSessionId = generateSessionId();
    const newState = initializeGame();
    sessionStates.set(newSessionId, {
      gameState: newState.state,
      isFirstTurn: true
    });
    return { sessionId: newSessionId, ...sessionStates.get(newSessionId) };
  }
  return { sessionId, ...sessionStates.get(sessionId) };
}

// File system helper functions for save/load system
const fs = require('fs').promises;

function getSavePath(sessionId) {
  return path.join(__dirname, 'saves', sessionId);
}

function getSaveFilePath(sessionId, saveName) {
  const cleanName = saveName.replace(/[^a-zA-Z0-9\s]/g, '').trim();
  return path.join(getSavePath(sessionId), `${cleanName}.json`);
}

async function ensureSaveDir(sessionId) {
  const savePath = getSavePath(sessionId);
  await fs.mkdir(savePath, { recursive: true });
}

async function getSaveCount(sessionId) {
  try {
    const savePath = getSavePath(sessionId);
    const files = await fs.readdir(savePath);
    return files.filter(file => file.endsWith('.json')).length;
  } catch (error) {
    return 0; // Directory doesn't exist yet
  }
}

async function findUniqueSaveName(sessionId, baseName) {
  const cleanBase = baseName.replace(/[^a-zA-Z0-9\s]/g, '').trim();
  let counter = 1;
  let candidateName = cleanBase;
  
  while (true) {
    const filePath = getSaveFilePath(sessionId, candidateName);
    try {
      await fs.access(filePath);
      // File exists, try next number
      candidateName = `${cleanBase} (${counter})`;
      counter++;
    } catch (error) {
      // File doesn't exist, we found our unique name
      return candidateName;
    }
    
    // Safety limit to prevent infinite loops
    if (counter > 100) {
      throw new Error('Could not find unique save name');
    }
  }
}

async function saveExists(sessionId, saveName) {
  try {
    const filePath = getSaveFilePath(sessionId, saveName);
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}
// =============================================================================
// SAVE/LOAD UTILITY FUNCTIONS (Option 3 Hybrid Approach)
// =============================================================================

async function performSave(sessionId, saveName, gameState) {
  if (!sessionId) {
    return { success: false, error: 'MISSING_SESSION_ID', message: 'Session ID is required' };
  }
  
  if (!saveName || typeof saveName !== 'string' || !saveName.trim()) {
    return { success: false, error: 'INVALID_SAVE_NAME', message: 'Save name is required and must be a string' };
  }
  
  const cleanSaveName = saveName.replace(/[^a-zA-Z0-9\s]/g, '').trim();
  if (cleanSaveName.length === 0) {
    return { success: false, error: 'INVALID_SAVE_NAME', message: 'Save name contains only invalid characters' };
  }
  
  if (cleanSaveName.length > 30) {
    return { success: false, error: 'INVALID_SAVE_NAME', message: 'Save name must be 30 characters or less' };
  }
  
  if (!gameState || typeof gameState !== 'object') {
    return { success: false, error: 'INVALID_GAME_STATE', message: 'Valid game state is required' };
  }
  
  try {
    const saveCount = await getSaveCount(sessionId);
    if (saveCount >= 5) {
      return { success: false, error: 'SAVE_LIMIT_EXCEEDED', message: 'Maximum of 5 saves allowed per session' };
    }
    
    await ensureSaveDir(sessionId);
    
    let finalSaveName = cleanSaveName;
    if (await saveExists(sessionId, cleanSaveName)) {
      finalSaveName = await findUniqueSaveName(sessionId, cleanSaveName);
    }
    
    const filePath = getSaveFilePath(sessionId, finalSaveName);
    const saveData = {
      gameState,
      timestamp: new Date().toISOString(),
      sessionId,
      saveName: finalSaveName
    };
    
    await fs.writeFile(filePath, JSON.stringify(saveData, null, 2));
    
    const stats = await fs.stat(filePath);
    const fileSizeKB = stats.size / 1024;
    if (fileSizeKB > 5) {
      console.warn(`[SAVE] Save file exceeds 5KB: ${fileSizeKB.toFixed(2)}KB`);
    }
    
    return { 
      success: true, 
      message: `Saved as ${finalSaveName}!`,
      saveName: finalSaveName,
      fileSizeKB: Math.round(fileSizeKB * 100) / 100
    };
    
  } catch (error) {
    console.error('[SAVE] Error:', error.message);
    return { success: false, error: 'SAVE_FAILED', message: 'Failed to save game: ' + error.message };
  }
}

async function performLoad(sessionId, saveName) {
  if (!sessionId) {
    return { success: false, error: 'MISSING_SESSION_ID', message: 'Session ID is required' };
  }
  
  if (!saveName || typeof saveName !== 'string' || !saveName.trim()) {
    return { success: false, error: 'INVALID_SAVE_NAME', message: 'Save name is required' };
  }
  
  try {
    const filePath = getSaveFilePath(sessionId, saveName);
    
    try {
      await fs.access(filePath);
    } catch (error) {
      return { success: false, error: 'SAVE_NOT_FOUND', message: `Save file '${saveName}' not found` };
    }
    
    const fileContent = await fs.readFile(filePath, 'utf8');
    const saveData = JSON.parse(fileContent);
    
    if (!saveData.gameState) {
      return { success: false, error: 'INVALID_SAVE_FILE', message: 'Save file is corrupted or invalid' };
    }
    
    return { 
      success: true, 
      gameState: saveData.gameState,
      message: `Game loaded from '${saveName}'`
    };
    
  } catch (error) {
    console.error('[LOAD] Error:', error.message);
    if (error instanceof SyntaxError) {
      return { success: false, error: 'LOAD_FAILED', message: 'Save file is corrupted (invalid JSON)' };
    }
    return { success: false, error: 'LOAD_FAILED', message: 'Failed to load game: ' + error.message };
  }
}

function performNewGame(sessionId) {
  try {
    const freshState = Engine.initState();
    return { success: true, gameState: freshState, message: "New game started" };
  } catch (error) {
    console.error('[NEWSAVE] Error:', error.message);
    return { success: false, error: 'NEW_GAME_FAILED', message: 'Failed to start new game: ' + error.message };
  }
}

async function listSavesData(sessionId) {
  if (!sessionId) {
    return { success: false, error: 'MISSING_SESSION_ID', message: 'Session ID is required' };
  }
  
  try {
    const savePath = getSavePath(sessionId);
    let files = [];
    
    try {
      files = await fs.readdir(savePath);
    } catch (error) {
      return { success: true, saves: [], count: 0 };
    }
    
    const saves = files
      .filter(file => file.endsWith('.json'))
      .map(file => {
        const saveName = file.replace('.json', '');
        return { name: saveName };
      });
    
    return { success: true, saves: saves, count: saves.length };
  } catch (error) {
    console.error('[SAVES] Error:', error.message);
    return { success: false, error: 'LIST_SAVES_FAILED', message: 'Failed to list saves: ' + error.message };
  }
}
// =============================================================================
// REFACTORED API ENDPOINTS (Using Utility Functions)
// =============================================================================

// ENDPOINT 1: POST /api/save
app.post('/api/save', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { saveName, gameState } = req.body;
  
  const result = await performSave(sessionId, saveName, gameState);
  
  if (result.success) {
    return res.json(result);
  } else {
    return res.status(400).json(result);
  }
});

// ENDPOINT 2: POST /api/load
app.post('/api/load', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { saveName } = req.body;
  
  const result = await performLoad(sessionId, saveName);
  
  if (result.success) {
    // Update session state with loaded game state
    sessionStates.set(sessionId, {
      gameState: result.gameState,
      isFirstTurn: false
    });
    
    return res.json({ 
      success: true, 
      gameState: result.gameState,
      sessionId: sessionId,
      message: result.message
    });
  } else {
    return res.status(result.error === 'SAVE_NOT_FOUND' ? 404 : 400).json(result);
  }
});

// ENDPOINT 3: GET /api/newsave
app.get('/api/newsave', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  
  const result = performNewGame(sessionId);
  
  if (result.success) {
    let resolvedSessionId = sessionId;
    
    if (sessionId && sessionStates.has(sessionId)) {
      // Reset existing session
      sessionStates.set(sessionId, {
        gameState: result.gameState,
        isFirstTurn: true
      });
    } else {
      // Create new session
      resolvedSessionId = generateSessionId();
      sessionStates.set(resolvedSessionId, {
        gameState: result.gameState,
        isFirstTurn: true
      });
    }
    
    return res.json({ 
      success: true, 
      gameState: result.gameState,
      sessionId: resolvedSessionId,
      message: result.message
    });
  } else {
    return res.status(500).json(result);
  }
});

// Bonus endpoint: GET /api/saves - List all saves for a session
app.get('/api/saves', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  
  const result = await listSavesData(sessionId);
  
  if (result.success) {
    return res.json(result);
  } else {
    return res.status(400).json(result);
  }
});
// =============================================================================
// SYSTEM COMMAND DETECTION FUNCTION
// =============================================================================

async function detectSystemCommand(input, sessionId, currentGameState, sessionStates) {
  const userInput = String(input).trim().toLowerCase();
  
  // Save Command: "save", "save myquest", "save as my adventure"
  const saveMatch = userInput.match(/^save(?:\s+(?:as\s+)?(.+))?$/i);
  if (saveMatch) {
    let saveName = saveMatch[1] ? saveMatch[1].trim() : `Save ${new Date().toLocaleTimeString()}`;
    
    // Sanitize save name
    saveName = saveName.replace(/[^a-zA-Z0-9\s]/g, '').trim();
    if (saveName.length > 30) {
      saveName = saveName.substring(0, 30);
    }
    if (saveName.length === 0) {
      saveName = `Save ${new Date().toLocaleTimeString()}`;
    }
    
    const result = await performSave(sessionId, saveName, currentGameState);
    return {
      isSystemCommand: true,
      message: result.success ? `✓ ${result.message}` : `❌ ${result.message}`,
      newState: currentGameState // State doesn't change on save
    };
  }
  
  // Load Command: "load myquest", "load save1"
  const loadMatch = userInput.match(/^load\s+(.+)$/i);
  if (loadMatch) {
    const saveName = loadMatch[1].trim();
    
    const result = await performLoad(sessionId, saveName);
    if (result.success) {
      // Update session state for subsequent turns
      sessionStates.set(sessionId, {
        gameState: result.gameState,
        isFirstTurn: false
      });
      
      return {
        isSystemCommand: true,
        message: `✓ ${result.message}`,
        newState: result.gameState
      };
    } else {
      return {
        isSystemCommand: true,
        message: `❌ ${result.message}`,
        newState: currentGameState
      };
    }
  }
  
  // New Game Command: "new game", "restart", "start over"
  const newGameMatch = userInput.match(/^(?:new\s+game|restart|start\s+over)$/i);
  if (newGameMatch) {
    const result = performNewGame(sessionId);
    if (result.success) {
      // Update session state
      sessionStates.set(sessionId, {
        gameState: result.gameState,
        isFirstTurn: true
      });
      
      return {
        isSystemCommand: true,
        message: `✓ ${result.message}`,
        newState: result.gameState
      };
    } else {
      return {
        isSystemCommand: true,
        message: `❌ ${result.message}`,
        newState: currentGameState
      };
    }
  }
  
  // List Saves Command: "list saves", "show saves", "my saves", "saves"
  const listSavesMatch = userInput.match(/^(?:list\s+saves|show\s+saves|my\s+saves|saves)$/i);
  if (listSavesMatch) {
    const result = await listSavesData(sessionId);
    if (result.success) {
      if (result.count === 0) {
        return {
          isSystemCommand: true,
          message: "No saves found.",
          newState: currentGameState
        };
      } else {
        const saveList = result.saves.map((save, index) => `${index + 1}. ${save.name}`).join(', ');
        return {
          isSystemCommand: true,
          message: `Your saves (${result.count}): ${saveList}`,
          newState: currentGameState
        };
      }
    } else {
      return {
        isSystemCommand: true,
        message: `❌ ${result.message}`,
        newState: currentGameState
      };
    }
  }
  
  // Not a system command
  return { isSystemCommand: false, message: "", newState: currentGameState };
}
// =============================================================================
// MODIFIED /NARRATE ENDPOINT WITH SYSTEM COMMAND INTEGRATION
// =============================================================================

// Existing narrate endpoint begins here
app.post('/narrate', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { sessionId: resolvedSessionId, gameState: sessionGameState, isFirstTurn: sessionIsFirstTurn } = getSessionState(sessionId);
  
  let gameState = sessionGameState;
  let isFirstTurn = sessionIsFirstTurn;
  
  const { action } = req.body;
  if (!action) {
    return res.status(400).json({ 
      sessionId: resolvedSessionId,
      error: 'action is required' 
    });
  }

  if (gameState === null) {
    const init = initializeGame();
    gameState = init.state;
    sessionStates.set(resolvedSessionId, { gameState, isFirstTurn: true });
  }

  // =========================================================================
  // SYSTEM COMMAND DETECTION (NEW INTEGRATION POINT)
  // =========================================================================
  const sysCmd = await detectSystemCommand(action, resolvedSessionId, gameState, sessionStates);
  if (sysCmd.isSystemCommand) {
    return res.json({
      sessionId: resolvedSessionId,
      narrative: sysCmd.message,
      state: sysCmd.newState || gameState,
      systemCommand: true
    });
  }
  // =========================================================================
  // END SYSTEM COMMAND DETECTION
  // =========================================================================

  const restartKeywords = ["new world", "restart", "begin again"];
  const actionLower = String(action).toLowerCase();
  if (restartKeywords.some(kw => actionLower.includes(kw))) {
    const init = initializeGame();
    gameState = init.state;
    isFirstTurn = true;
    sessionStates.set(resolvedSessionId, { gameState, isFirstTurn });
    return res.json({
      sessionId: resolvedSessionId,
      narrative: "Describe your world in 3 sentences.",
      state: gameState,
      restart: true
    });
  }

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
  
  // ... [REST OF EXISTING /NARRATE LOGIC REMAINS UNCHANGED] ...
  // Continue with existing SemanticParser, Engine, and DeepSeek API flow
  // (Preserving all existing code below this point)
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

  // Before-turn debug info
  const beforeCells = Object.keys(gameState?.world?.cells || {}).length;
  console.log('[turn] cells_before=', beforeCells);

  // First turn: seed world using WORLD_PROMPT through Engine
  let engineOutput = null;
  if (isFirstTurn === true) {
    isFirstTurn = false;
    sessionStates.set(resolvedSessionId, { gameState, isFirstTurn });
    const inputObj = mapActionToInput(action, "WORLD_PROMPT");
    try {
      engineOutput = Engine.buildOutput(gameState, inputObj);
      if (engineOutput && engineOutput.state) {
        gameState = engineOutput.state;
        sessionStates.set(resolvedSessionId, { gameState, isFirstTurn });
      }
    } catch (err) {
      console.error('Engine error on first turn:', err.message);
      return res.json({ 
        sessionId: resolvedSessionId,
        error: `engine_failed: ${err.message}`, 
        narrative: "The engine encountered an error initializing the world.",
        state: gameState,
        debug 
      });
    }
  } else {
    // Ongoing turn: infer MOVE vs FREEFORM and call Engine
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
          sessionId: resolvedSessionId,
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
            sessionId: resolvedSessionId,
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
          if (result && result.state) {
            gameState = result.state;
            sessionStates.set(resolvedSessionId, { gameState, isFirstTurn });
          }
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

      if (!engineOutput) {
        engineOutput = Engine.buildOutput(gameState, inputObj);
      }
      
      if (engineOutput && engineOutput.state) {
        gameState = engineOutput.state;
        sessionStates.set(resolvedSessionId, { gameState, isFirstTurn });
      }
    } catch (err) {
      console.error('Engine error:', err.message);
      return res.json({ 
        sessionId: resolvedSessionId,
        error: `engine_failed: ${err.message}`, 
        narrative: "The engine encountered an error processing your action.",
        state: gameState,
        debug
      });
    }
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
      sessionId: resolvedSessionId,
      error: 'DEEPSEEK_API_KEY not set',
      narrative: "The engine processes your action.",
      state: gameState,
      engine_output: engineOutput,
      scene,
      debug
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
    return res.json({ 
      sessionId: resolvedSessionId,
      narrative, 
      state: gameState, 
      engine_output: engineOutput, 
      scene, 
      debug 
    });
  } catch (err) {
    console.error('DeepSeek error:', err.message);
    return res.json({ 
      sessionId: resolvedSessionId,
      narrative: "The engine processes your action.",
      state: gameState,
      engine_output: engineOutput,
      scene,
      error: err.message,
      debug
    });
  }
});

// =============================================================================
// REMAINING ENDPOINTS AND SERVER STARTUP (UNCHANGED)
// =============================================================================

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
  return {
    status: "world_created",
    state: state,
    prompt: "Describe your world in 3 sentences."
  };
}

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'Index.html');
  res.sendFile(htmlPath);
});

app.post('/init', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { sessionId: resolvedSessionId, gameState, isFirstTurn } = getSessionState(sessionId);
  const result = {
    sessionId: resolvedSessionId,
    status: "world_created",
    state: gameState,
    prompt: "Describe your world in 3 sentences."
  };
  return res.json(result);
});

app.post('/reset', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (sessionId && sessionStates.has(sessionId)) {
    const newState = initializeGame();
    sessionStates.set(sessionId, {
      gameState: newState.state,
      isFirstTurn: true
    });
  }
  const { sessionId: resolvedSessionId, gameState, isFirstTurn } = getSessionState(sessionId);
  const result = {
    sessionId: resolvedSessionId,
    status: "world_created", 
    state: gameState,
    prompt: "Describe your world in 3 sentences."
  };
  return res.json(result);
});

app.get('/status', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { sessionId: resolvedSessionId, gameState, isFirstTurn } = getSessionState(sessionId);
  return res.json({
    sessionId: resolvedSessionId,
    status: 'running',
    hasGameState: gameState !== null,
    isFirstTurn: isFirstTurn,
    playerLocation: gameState?.player?.mx || null
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});