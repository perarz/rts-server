// ============================================
// RTS MULTIPLAYER SERVER - 4 PLAYERS (1v1v1v1)
// ============================================
const WebSocket = require('ws');
const http = require('http');

// Konfiguracja
const PORT = process.env.PORT || 3001;
const TICK_RATE = 30; // 30 Hz
const TICK_INTERVAL = 1000 / TICK_RATE; // ~33ms

const CANVAS_WIDTH = 1600;
const CANVAS_HEIGHT = 900;

// Koszty produkcji
const COSTS = {
  worker: 100,
  knight: 200
};

// Statystyki jednostek
const UNIT_STATS = {
  worker: { speed: 4, size: 20, maxGold: 10, miningTime: 60 },
  knight: { speed: 4, size: 20, health: 100, damage: 10, attackRange: 40, attackSpeed: 30 }
};

// Spawny dla 4 graczy (narożniki)
const SPAWNS = [
  { x: 150, y: CANVAS_HEIGHT - 150, color: '#3b82f6' }, // Team 1: dół-lewo (niebieski)
  { x: 150, y: 150, color: '#10b981' },                  // Team 2: góra-lewo (zielony)
  { x: CANVAS_WIDTH - 150, y: 150, color: '#ef4444' },   // Team 3: góra-prawo (czerwony)
  { x: CANVAS_WIDTH - 150, y: CANVAS_HEIGHT - 150, color: '#f59e0b' } // Team 4: dół-prawo (żółty)
];

// 10 kopalni rozmieszczonych symetrycznie
const GOLD_MINES = [
  { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 },           // Centrum
  { x: CANVAS_WIDTH / 4, y: CANVAS_HEIGHT / 4 },           // Lewy górny kwadrant
  { x: 3 * CANVAS_WIDTH / 4, y: CANVAS_HEIGHT / 4 },       // Prawy górny kwadrant
  { x: CANVAS_WIDTH / 4, y: 3 * CANVAS_HEIGHT / 4 },       // Lewy dolny kwadrant
  { x: 3 * CANVAS_WIDTH / 4, y: 3 * CANVAS_HEIGHT / 4 },   // Prawy dolny kwadrant
  { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 4 },           // Góra centrum
  { x: CANVAS_WIDTH / 2, y: 3 * CANVAS_HEIGHT / 4 },       // Dół centrum
  { x: CANVAS_WIDTH / 4, y: CANVAS_HEIGHT / 2 },           // Lewo centrum
  { x: 3 * CANVAS_WIDTH / 4, y: CANVAS_HEIGHT / 2 },       // Prawo centrum
  { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 6 }            // Dodatkowa górna
];

// Stan gry
const gameState = {
  tick: 0,
  players: {}, // { clientId: { teamId, name, gold, units: [], base: {} } }
  units: {},   // { unitId: { type, teamId, x, y, ... } }
  buildings: {}, // { buildingId: { type, teamId, x, y, health, ... } }
  goldMines: []
};

// Inicjalizacja kopalni
GOLD_MINES.forEach((mine, idx) => {
  gameState.goldMines.push({
    id: `mine-${idx}`,
    x: mine.x,
    y: mine.y,
    size: 40
  });
});

// WebSocket Server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('RTS Multiplayer Server Running\n');
});

const wss = new WebSocket.Server({ server });

const clients = new Map(); // Map<WebSocket, { clientId, teamId, name }>

// Helper: Generuj unikalne ID
function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Helper: Dystans między punktami
function distance(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

// Broadcast do wszystkich klientów
function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Wyślij do konkretnego klienta
function sendTo(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// Inicjalizacja gracza
function initPlayer(clientId, teamId, name) {
  const spawn = SPAWNS[teamId];
  
  // Baza gracza
  const baseId = `base-${clientId}`;
  gameState.buildings[baseId] = {
    id: baseId,
    type: 'base',
    teamId,
    x: spawn.x,
    y: spawn.y,
    size: 60,
    health: 1000,
    maxHealth: 1000
  };

  // Startowy robotnik
  const workerId = `${clientId}-worker-0`;
  gameState.units[workerId] = {
    id: workerId,
    type: 'worker',
    teamId,
    x: spawn.x + 70,
    y: spawn.y,
    targetX: spawn.x + 70,
    targetY: spawn.y,
    speed: UNIT_STATS.worker.speed,
    size: UNIT_STATS.worker.size,
    carryingGold: 0,
    maxGold: UNIT_STATS.worker.maxGold,
    state: 'idle',
    miningTarget: null,
    miningProgress: 0
  };

  gameState.players[clientId] = {
    teamId,
    name,
    gold: 500, // Startowe złoto
    baseId,
    unitIds: [workerId]
  };

  console.log(`✅ Gracz ${name} (Team ${teamId + 1}) dołączył. Spawn: (${spawn.x}, ${spawn.y})`);
}

// Znajdź wolny slot (0-3)
function findFreeSlot() {
  const occupiedSlots = Object.values(gameState.players).map(p => p.teamId);
  for (let i = 0; i < 4; i++) {
    if (!occupiedSlots.includes(i)) return i;
  }
  return -1; // Brak wolnych slotów
}

// Reset gry gdy zostanie 1 gracz lub wszyscy zginą
function checkGameOver() {
  const alivePlayers = Object.entries(gameState.players).filter(([clientId, player]) => {
    const base = gameState.buildings[player.baseId];
    return base && base.health > 0;
  });

  if (alivePlayers.length === 1) {
    const [winnerId, winner] = alivePlayers[0];
    broadcast({
      type: 'game_over',
      winner: winner.name,
      message: `🎉 ${winner.name} WYGRYWA GRĘ!`
    });
    console.log(`🏆 ZWYCIĘZCA: ${winner.name}`);
    
    // Reset gry po 5 sekundach
    setTimeout(resetGame, 5000);
    return true;
  }

  if (alivePlayers.length === 0) {
    broadcast({
      type: 'game_over',
      winner: null,
      message: '💀 REMIS! Wszyscy zostali wyeliminowani!'
    });
    console.log('💀 Gra zakończona remisem');
    setTimeout(resetGame, 5000);
    return true;
  }

  return false;
}

// Reset całej gry
function resetGame() {
  console.log('🔄 Resetowanie gry...');
  
  // Wyczyść wszystko
  gameState.tick = 0;
  gameState.units = {};
  gameState.buildings = {};
  
  // Reinicjalizuj graczy którzy są nadal podłączeni
  const connectedClients = Array.from(clients.entries());
  gameState.players = {};
  
  connectedClients.forEach(([ws, clientData], idx) => {
    if (idx < 4) { // Max 4 graczy
      initPlayer(clientData.clientId, idx, clientData.name);
      clientData.teamId = idx;
    }
  });

  // Broadcast nowego stanu
  broadcast({
    type: 'game_reset',
    message: '🔄 Gra została zresetowana!'
  });

  broadcastSnapshot();
}

// Obsługa komendy produkcji
function handleProduce(clientId, unitType) {
  const player = gameState.players[clientId];
  if (!player) return;

  const cost = COSTS[unitType];
  if (!cost || player.gold < cost) {
    return; // Brak środków
  }

  // Odejmij złoto
  player.gold -= cost;

  // Stwórz jednostkę przy bazie
  const base = gameState.buildings[player.baseId];
  const unitId = `${clientId}-${unitType}-${Date.now()}`;
  
  const offset = unitType === 'worker' ? 70 : -70;
  
  if (unitType === 'worker') {
    gameState.units[unitId] = {
      id: unitId,
      type: 'worker',
      teamId: player.teamId,
      x: base.x + offset,
      y: base.y,
      targetX: base.x + offset,
      targetY: base.y,
      speed: UNIT_STATS.worker.speed,
      size: UNIT_STATS.worker.size,
      carryingGold: 0,
      maxGold: UNIT_STATS.worker.maxGold,
      state: 'idle',
      miningTarget: null,
      miningProgress: 0
    };
  } else if (unitType === 'knight') {
    gameState.units[unitId] = {
      id: unitId,
      type: 'knight',
      teamId: player.teamId,
      x: base.x + offset,
      y: base.y,
      targetX: base.x + offset,
      targetY: base.y,
      speed: UNIT_STATS.knight.speed,
      size: UNIT_STATS.knight.size,
      health: UNIT_STATS.knight.health,
      maxHealth: UNIT_STATS.knight.health,
      damage: UNIT_STATS.knight.damage,
      attackRange: UNIT_STATS.knight.attackRange,
      attackCooldown: 0,
      target: null
    };
  }

  player.unitIds.push(unitId);

  broadcast({
    type: 'event',
    event: 'unit_produced',
    unitType,
    teamId: player.teamId,
    playerName: player.name
  });

  console.log(`👷 ${player.name} wyprodukował ${unitType}`);
}

// Obsługa komendy ruchu
function handleMove(clientId, unitId, x, y) {
  const unit = gameState.units[unitId];
  const player = gameState.players[clientId];
  
  if (!unit || !player || unit.teamId !== player.teamId) return;

  // Walidacja teleportów (max 500px na tick)
  const maxMove = unit.speed * 15;
  const dist = distance(unit.x, unit.y, x, y);
  if (dist > maxMove) return; // Zbyt duży skok

  unit.targetX = Math.max(0, Math.min(CANVAS_WIDTH, x));
  unit.targetY = Math.max(0, Math.min(CANVAS_HEIGHT, y));
  
  // Resetuj mining jeśli worker się rusza
  if (unit.type === 'worker') {
    unit.state = 'idle';
    unit.miningTarget = null;
  }
}

// Obsługa komendy kopania
function handleMine(clientId, unitId, mineId) {
  const unit = gameState.units[unitId];
  const player = gameState.players[clientId];
  const mine = gameState.goldMines.find(m => m.id === mineId);
  
  if (!unit || !player || !mine || unit.teamId !== player.teamId || unit.type !== 'worker') return;

  unit.state = 'moving_to_mine';
  unit.miningTarget = mineId;
  unit.targetX = mine.x - 21;
  unit.targetY = mine.y - 21;
}

// GŁÓWNA PĘTLA TICKA SERWERA (30 Hz)
function gameTick() {
  gameState.tick++;

  // Aktualizuj jednostki
  Object.values(gameState.units).forEach(unit => {
    // Ruch jednostek
    const dx = unit.targetX - unit.x;
    const dy = unit.targetY - unit.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > unit.speed) {
      unit.x += (dx / dist) * unit.speed;
      unit.y += (dy / dist) * unit.speed;
    }

    // Logika Worker - kopanie złota
    if (unit.type === 'worker') {
      const player = Object.values(gameState.players).find(p => p.teamId === unit.teamId);
      if (!player) return;

      const base = gameState.buildings[player.baseId];
      if (!base) return;

      if (unit.state === 'moving_to_mine' && unit.miningTarget) {
        const mine = gameState.goldMines.find(m => m.id === unit.miningTarget);
        if (mine && distance(unit.x, unit.y, mine.x, mine.y) < 50) {
          unit.state = 'mining';
          unit.miningProgress = 0;
        }
      } else if (unit.state === 'mining') {
        unit.miningProgress++;
        if (unit.miningProgress >= UNIT_STATS.worker.miningTime) {
          unit.carryingGold = unit.maxGold;
          unit.state = 'returning';
          unit.targetX = base.x;
          unit.targetY = base.y;
        }
      } else if (unit.state === 'returning') {
        if (distance(unit.x, unit.y, base.x, base.y) < 40) {
          player.gold += unit.carryingGold;
          unit.carryingGold = 0;
          
          // Wróć do kopalni
          if (unit.miningTarget) {
            const mine = gameState.goldMines.find(m => m.id === unit.miningTarget);
            if (mine) {
              unit.state = 'moving_to_mine';
              unit.targetX = mine.x - 21;
              unit.targetY = mine.y - 21;
            }
          } else {
            unit.state = 'idle';
          }
        }
      }
    }

    // Logika Knight - atak
    if (unit.type === 'knight') {
      if (unit.attackCooldown > 0) {
        unit.attackCooldown--;
      }

      const isMoving = distance(unit.x, unit.y, unit.targetX, unit.targetY) > unit.speed * 1.5;
      if (isMoving) {
        unit.target = null;
        return;
      }

      // Znajdź najbliższego wroga
      let nearestEnemy = null;
      let minDist = Infinity;

      // Wrogowie: inne knighty + bazy
      Object.values(gameState.units).forEach(other => {
        if (other.type === 'knight' && other.teamId !== unit.teamId && other.health > 0) {
          const d = distance(unit.x, unit.y, other.x, other.y);
          if (d < minDist) {
            minDist = d;
            nearestEnemy = other;
          }
        }
      });

      Object.values(gameState.buildings).forEach(building => {
        if (building.teamId !== unit.teamId && building.health > 0) {
          const d = distance(unit.x, unit.y, building.x, building.y);
          if (d < minDist) {
            minDist = d;
            nearestEnemy = building;
          }
        }
      });

      if (nearestEnemy && minDist <= unit.attackRange) {
        unit.target = nearestEnemy.id;
        if (unit.attackCooldown === 0) {
          nearestEnemy.health -= unit.damage;
          unit.attackCooldown = UNIT_STATS.knight.attackSpeed;

          broadcast({
            type: 'event',
            event: 'attack',
            attackerId: unit.id,
            targetId: nearestEnemy.id,
            damage: unit.damage
          });

          // Śmierć jednostki
          if (nearestEnemy.health <= 0) {
            if (nearestEnemy.type === 'knight') {
              delete gameState.units[nearestEnemy.id];
              broadcast({
                type: 'event',
                event: 'unit_died',
                unitId: nearestEnemy.id
              });
            } else if (nearestEnemy.type === 'base') {
              // Baza zniszczona
              const deadPlayer = Object.values(gameState.players).find(p => p.baseId === nearestEnemy.id);
              if (deadPlayer) {
                broadcast({
                  type: 'event',
                  event: 'base_destroyed',
                  teamId: deadPlayer.teamId,
                  playerName: deadPlayer.name
                });
                console.log(`💀 Baza gracza ${deadPlayer.name} została zniszczona!`);
              }
            }
          }
        }
      } else if (nearestEnemy && minDist < 100) {
        // Podejdź bliżej
        unit.targetX = nearestEnemy.x;
        unit.targetY = nearestEnemy.y;
        unit.target = nearestEnemy.id;
      } else {
        unit.target = null;
      }
    }
  });

  // Sprawdź koniec gry
  checkGameOver();

  // Co 3 ticki wysyłaj snapshot (10 Hz dla oszczędności)
  if (gameState.tick % 3 === 0) {
    broadcastSnapshot();
  }
}

// Broadcast snapshotu stanu gry
function broadcastSnapshot() {
  const snapshot = {
    type: 'snapshot',
    tick: gameState.tick,
    units: Object.values(gameState.units),
    buildings: Object.values(gameState.buildings),
    players: Object.entries(gameState.players).map(([clientId, player]) => ({
      clientId,
      teamId: player.teamId,
      name: player.name,
      gold: player.gold
    })),
    goldMines: gameState.goldMines
  };

  broadcast(snapshot);
}

// WebSocket Connection Handler
wss.on('connection', (ws) => {
  console.log('🔌 Nowe połączenie WebSocket');

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'join': {
          // Sprawdź limit graczy
          if (clients.size >= 4) {
            sendTo(ws, { type: 'room_full', message: '🚫 Pokój pełny! Maksymalnie 4 graczy.' });
            ws.close();
            return;
          }

          const teamId = findFreeSlot();
          if (teamId === -1) {
            sendTo(ws, { type: 'room_full', message: '🚫 Pokój pełny!' });
            ws.close();
            return;
          }

          const clientId = generateId('player');
          const name = message.name || `Gracz ${teamId + 1}`;

          clients.set(ws, { clientId, teamId, name });
          initPlayer(clientId, teamId, name);

          sendTo(ws, {
            type: 'joined',
            clientId,
            teamId,
            name,
            spawn: SPAWNS[teamId]
          });

          broadcast({
            type: 'event',
            event: 'player_joined',
            teamId,
            name
          });

          broadcastSnapshot();
          break;
        }

        case 'command': {
          const clientData = clients.get(ws);
          if (!clientData) return;

          const { command, payload } = message;

          switch (command) {
            case 'produce':
              handleProduce(clientData.clientId, payload.unitType);
              break;
            case 'move':
              handleMove(clientData.clientId, payload.unitId, payload.x, payload.y);
              break;
            case 'mine':
              handleMine(clientData.clientId, payload.unitId, payload.mineId);
              break;
          }
          break;
        }

        case 'ping':
          sendTo(ws, { type: 'pong', timestamp: Date.now() });
          break;
      }
    } catch (error) {
      console.error('❌ Błąd parsowania wiadomości:', error);
    }
  });

  ws.on('close', () => {
    const clientData = clients.get(ws);
    if (clientData) {
      console.log(`👋 Gracz ${clientData.name} (Team ${clientData.teamId + 1}) rozłączył się`);
      
      // Usuń gracza i jego jednostki
      delete gameState.players[clientData.clientId];
      
      Object.keys(gameState.units).forEach(unitId => {
        if (unitId.startsWith(clientData.clientId)) {
          delete gameState.units[unitId];
        }
      });
      
      Object.keys(gameState.buildings).forEach(buildingId => {
        if (buildingId.includes(clientData.clientId)) {
          delete gameState.buildings[buildingId];
        }
      });

      clients.delete(ws);

      broadcast({
        type: 'event',
        event: 'player_left',
        teamId: clientData.teamId,
        name: clientData.name
      });

      broadcastSnapshot();
      checkGameOver();
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });
});

// Start serwera
setInterval(gameTick, TICK_INTERVAL);

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║  🎮 RTS MULTIPLAYER SERVER                        ║
║  Port: ${PORT}                                    ║
║  Tick Rate: ${TICK_RATE} Hz (${TICK_INTERVAL.toFixed(1)}ms)              ║
║  Max Players: 4 (1v1v1v1)                         ║
║  Canvas: ${CANVAS_WIDTH}x${CANVAS_HEIGHT}                           ║
╚════════════════════════════════════════════════════╝
  `);
});