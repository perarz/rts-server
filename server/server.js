const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3001;
const TICK_RATE = 30;
const TICK_INTERVAL = 1000 / TICK_RATE;

const CANVAS_WIDTH = 2000;
const CANVAS_HEIGHT = 1200;
const MAX_WORKERS = 25;

const COSTS = {
  worker: 200,
  knight: 400,
  champion: 1500,
  workerUpgrade: 1000,
  baseUpgrade: 1000
};

const UNIT_STATS = {
  worker: { 
    speed: 3, 
    size: 15, 
    maxGold: 10, 
    miningTime: 60,
    health: 40,
    maxHealth: 40
  },
  workerUpgraded: {
    speed: 5,
    size: 15,
    maxGold: 15,
    miningTime: 50,
    health: 70,
    maxHealth: 70
  },
  knight: { 
    speed: 3, 
    size: 25, 
    health: 120, 
    maxHealth: 120,
    damage: 30, 
    attackRange: 40, 
    attackSpeed: 30 
  },
  champion: {
    speed: 3,
    size: 30,
    health: 300,
    maxHealth: 300,
    damage: 50,
    attackRange: 50,
    attackSpeed: 25
  },
  base: {
    health: 500,
    maxHealth: 500,
    size: 60,
    damage: 40,
    attackRange: 600,
    attackSpeed: 30,
    passiveIncome: 50,
    passiveInterval: 900
  },
  baseUpgraded: {
    health: 1000,
    maxHealth: 1000,
    size: 60,
    damage: 50,
    attackRange: 900,
    attackSpeed: 30,
    passiveIncome: 100,
    passiveInterval: 900
  }
};

const SPAWNS = [
  { x: 200, y: CANVAS_HEIGHT - 200, color: '#3b82f6' },
  { x: 200, y: 200, color: '#10b981' },
  { x: CANVAS_WIDTH - 200, y: 200, color: '#ef4444' },
  { x: CANVAS_WIDTH - 200, y: CANVAS_HEIGHT - 200, color: '#f59e0b' }
];

const GOLD_MINES = [
  { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2, totalGold: 10000, type: 'central' },
  { x: CANVAS_WIDTH / 4, y: CANVAS_HEIGHT / 4, totalGold: 700, type: 'near' },
  { x: 3 * CANVAS_WIDTH / 4, y: CANVAS_HEIGHT / 4, totalGold: 700, type: 'near' },
  { x: CANVAS_WIDTH / 4, y: 3 * CANVAS_HEIGHT / 4, totalGold: 700, type: 'near' },
  { x: 3 * CANVAS_WIDTH / 4, y: 3 * CANVAS_HEIGHT / 4, totalGold: 700, type: 'near' },
  { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 4, totalGold: 2000, type: 'far' },
  { x: CANVAS_WIDTH / 2, y: 3 * CANVAS_HEIGHT / 4, totalGold: 2000, type: 'far' },
  { x: CANVAS_WIDTH / 4, y: CANVAS_HEIGHT / 2, totalGold: 2000, type: 'far' },
  { x: 3 * CANVAS_WIDTH / 4, y: CANVAS_HEIGHT / 2, totalGold: 2000, type: 'far' },
  { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 6, totalGold: 2000, type: 'far' }
];

const gameState = {
  tick: 0,
  gameStarted: false,
  minPlayersToStart: 2,
  players: {},
  units: {},
  buildings: {},
  goldMines: [],
  occupiedSlots: new Set()
};

GOLD_MINES.forEach((mine, idx) => {
  gameState.goldMines.push({
    id: `mine-${idx}`,
    x: mine.x,
    y: mine.y,
    size: 40,
    totalGold: mine.totalGold,
    remainingGold: mine.totalGold,
    type: mine.type,
    depleted: false
  });
});

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('RTS Multiplayer Server v0.8 BETA\n');
});

const wss = new WebSocket.Server({ server });
const clients = new Map();

function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function distance(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function sendTo(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function initPlayer(clientId, teamId, name) {
  const spawn = SPAWNS[teamId];
  
  const baseId = `base-${clientId}`;
  gameState.buildings[baseId] = {
    id: baseId,
    type: 'base',
    teamId,
    x: spawn.x,
    y: spawn.y,
    size: UNIT_STATS.base.size,
    health: UNIT_STATS.base.health,
    maxHealth: UNIT_STATS.base.maxHealth,
    damage: UNIT_STATS.base.damage,
    attackRange: UNIT_STATS.base.attackRange,
    attackCooldown: 0,
    target: null,
    passiveIncome: UNIT_STATS.base.passiveIncome,
    passiveTimer: 0,
    upgraded: false
  };

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
    health: UNIT_STATS.worker.health,
    maxHealth: UNIT_STATS.worker.maxHealth,
    carryingGold: 0,
    maxGold: UNIT_STATS.worker.maxGold,
    state: 'idle',
    miningTarget: null,
    miningProgress: 0,
    autoMining: false
  };

  gameState.players[clientId] = {
    teamId,
    name,
    gold: 500,
    baseId,
    unitIds: [workerId],
    workerUpgraded: false
  };

  gameState.occupiedSlots.add(teamId);
  console.log(`✅ Gracz ${name} (Team ${teamId + 1}) dołączył. Spawn: (${spawn.x}, ${spawn.y})`);
}

function findFreeSlot() {
  for (let i = 0; i < 4; i++) {
    if (!gameState.occupiedSlots.has(i)) return i;
  }
  return -1;
}

function checkGameStart() {
  const playerCount = Object.keys(gameState.players).length;
  
  if (!gameState.gameStarted && playerCount >= gameState.minPlayersToStart) {
    gameState.gameStarted = true;
    broadcast({
      type: 'event',
      event: 'game_started',
      message: `🎮 Gra rozpoczęta! ${playerCount} graczy.`
    });
    console.log(`🎮 Gra rozpoczęta z ${playerCount} graczami`);
  }
}

function checkGameOver() {
  const playerCount = Object.keys(gameState.players).length;
  
  if (!gameState.gameStarted) return false;
  
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
    
    if (playerCount >= 2) {
      setTimeout(resetGame, 5000);
    } else {
      console.log('⏸️ Czekam na więcej graczy przed resetem...');
    }
    return true;
  }

  if (alivePlayers.length === 0) {
    broadcast({
      type: 'game_over',
      winner: null,
      message: '💀 REMIS! Wszyscy zostali wyeliminowani!'
    });
    console.log('💀 Gra zakończona remisem');
    
    if (playerCount >= 2) {
      setTimeout(resetGame, 5000);
    }
    return true;
  }

  return false;
}

function resetGame() {
  console.log('🔄 Resetowanie gry...');
  
  gameState.tick = 0;
  gameState.gameStarted = false;
  gameState.units = {};
  gameState.buildings = {};
  
  gameState.goldMines.forEach(mine => {
    mine.remainingGold = mine.totalGold;
    mine.depleted = false;
  });
  
  const connectedClients = Array.from(clients.entries());
  gameState.players = {};
  
  connectedClients.forEach(([ws, clientData], idx) => {
    if (idx < 4) {
      initPlayer(clientData.clientId, idx, clientData.name);
      clientData.teamId = idx;
    }
  });

  broadcast({
    type: 'game_reset',
    message: '🔄 Gra została zresetowana!'
  });

  broadcastSnapshot();
  checkGameStart();
}

function handleCollisions(unit) {
  const pushStrength = 2.5;
  const collisionRadius = 30;
  
  Object.values(gameState.units).forEach(other => {
    if (other.id === unit.id) return;
    
    const dist = distance(unit.x, unit.y, other.x, other.y);
    const minDist = collisionRadius;
    
    if (dist < minDist && dist > 0) {
      const pushX = (unit.x - other.x) / dist * pushStrength;
      const pushY = (unit.y - other.y) / dist * pushStrength;
      
      unit.x += pushX;
      unit.y += pushY;
    }
  });
  
  Object.values(gameState.buildings).forEach(building => {
    const dist = distance(unit.x, unit.y, building.x, building.y);
    const minDist = building.size / 2 + collisionRadius;
    
    if (dist < minDist && dist > 0) {
      const pushX = (unit.x - building.x) / dist * pushStrength;
      const pushY = (unit.y - building.y) / dist * pushStrength;
      
      unit.x += pushX;
      unit.y += pushY;
    }
  });
  
  gameState.goldMines.forEach(mine => {
    const dist = distance(unit.x, unit.y, mine.x, mine.y);
    const minDist = mine.size / 2 + collisionRadius;
    
    if (dist < minDist && dist > 0) {
      const pushX = (unit.x - mine.x) / dist * pushStrength;
      const pushY = (unit.y - mine.y) / dist * pushStrength;
      
      unit.x += pushX;
      unit.y += pushY;
    }
  });
  
  unit.x = Math.max(20, Math.min(CANVAS_WIDTH - 20, unit.x));
  unit.y = Math.max(20, Math.min(CANVAS_HEIGHT - 20, unit.y));
}

function findFreeSpotAroundMine(mine, unit) {
  const angles = [0, 45, 90, 135, 180, 225, 270, 315];
  const radius = 50;
  
  for (const angle of angles) {
    const rad = angle * Math.PI / 180;
    const testX = mine.x + Math.cos(rad) * radius;
    const testY = mine.y + Math.sin(rad) * radius;
    
    let isFree = true;
    Object.values(gameState.units).forEach(other => {
      if (other.id !== unit.id && distance(testX, testY, other.x, other.y) < 30) {
        isFree = false;
      }
    });
    
    if (isFree) {
      return { x: testX, y: testY };
    }
  }
  
  return { x: mine.x - 21, y: mine.y - 21 };
}

function handleProduce(clientId, unitType) {
  const player = gameState.players[clientId];
  if (!player) return;

  const base = gameState.buildings[player.baseId];
  if (!base || base.health <= 0) {
    console.log(`⚠️ ${player.name} nie może produkować - baza zniszczona`);
    return;
  }

  if (unitType === 'worker') {
    const workerCount = Object.values(gameState.units).filter(u => 
      u.type === 'worker' && u.teamId === player.teamId
    ).length;
    
    if (workerCount >= MAX_WORKERS) {
      console.log(`⚠️ ${player.name} osiągnął limit robotników (${MAX_WORKERS})`);
      return;
    }
  }

  const cost = COSTS[unitType];
  if (!cost || player.gold < cost) return;

  player.gold -= cost;
  const unitId = `${clientId}-${unitType}-${Date.now()}`;
  const offset = unitType === 'worker' ? 70 : -70;
  
  if (unitType === 'worker') {
    const stats = player.workerUpgraded ? UNIT_STATS.workerUpgraded : UNIT_STATS.worker;
    
    gameState.units[unitId] = {
      id: unitId,
      type: 'worker',
      teamId: player.teamId,
      x: base.x + offset,
      y: base.y,
      targetX: base.x + offset,
      targetY: base.y,
      speed: stats.speed,
      size: stats.size,
      health: stats.health,
      maxHealth: stats.maxHealth,
      carryingGold: 0,
      maxGold: stats.maxGold,
      state: 'idle',
      miningTarget: null,
      miningProgress: 0,
      upgraded: player.workerUpgraded,
      autoMining: false
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
      maxHealth: UNIT_STATS.knight.maxHealth,
      damage: UNIT_STATS.knight.damage,
      attackRange: UNIT_STATS.knight.attackRange,
      attackCooldown: Math.floor(Math.random() * 15),
      target: null
    };
  } else if (unitType === 'champion') {
    gameState.units[unitId] = {
      id: unitId,
      type: 'champion',
      teamId: player.teamId,
      x: base.x + offset,
      y: base.y,
      targetX: base.x + offset,
      targetY: base.y,
      speed: UNIT_STATS.champion.speed,
      size: UNIT_STATS.champion.size,
      health: UNIT_STATS.champion.health,
      maxHealth: UNIT_STATS.champion.maxHealth,
      damage: UNIT_STATS.champion.damage,
      attackRange: UNIT_STATS.champion.attackRange,
      attackCooldown: Math.floor(Math.random() * 15),
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

function handleWorkerUpgrade(clientId) {
  const player = gameState.players[clientId];
  if (!player) return;
  
  if (player.workerUpgraded) {
    console.log(`⚠️ ${player.name} już ma upgrade robotników`);
    return;
  }
  
  const workerCount = Object.values(gameState.units).filter(u => 
    u.type === 'worker' && u.teamId === player.teamId
  ).length;
  
  const cost = COSTS.workerUpgrade + (workerCount * 100);
  
  if (player.gold < cost) {
    console.log(`⚠️ ${player.name} nie ma złota na upgrade (${player.gold}/${cost})`);
    return;
  }
  
  player.gold -= cost;
  player.workerUpgraded = true;
  
  Object.values(gameState.units).forEach(unit => {
    if (unit.type === 'worker' && unit.teamId === player.teamId) {
      const stats = UNIT_STATS.workerUpgraded;
      unit.speed = stats.speed;
      unit.maxGold = stats.maxGold;
      unit.maxHealth = stats.maxHealth;
      unit.health = stats.maxHealth;
      unit.upgraded = true;
    }
  });
  
  broadcast({
    type: 'event',
    event: 'worker_upgraded',
    teamId: player.teamId,
    playerName: player.name
  });
  
  console.log(`⚡ ${player.name} kupił upgrade robotników za ${cost} złota`);
}

function handleBaseUpgrade(clientId) {
  const player = gameState.players[clientId];
  if (!player) return;
  
  const base = gameState.buildings[player.baseId];
  if (!base || base.health <= 0) {
    console.log(`⚠️ ${player.name} nie może upgrade'ować - baza zniszczona`);
    return;
  }
  
  if (base.upgraded) {
    console.log(`⚠️ ${player.name} już ma upgrade bazy`);
    return;
  }
  
  const cost = COSTS.baseUpgrade;
  
  if (player.gold < cost) {
    console.log(`⚠️ ${player.name} nie ma złota na upgrade bazy (${player.gold}/${cost})`);
    return;
  }
  
  player.gold -= cost;
  base.upgraded = true;
  
  const upgradedStats = UNIT_STATS.baseUpgraded;
  base.maxHealth = upgradedStats.maxHealth;
  base.health = upgradedStats.maxHealth;
  base.damage = upgradedStats.damage;
  base.attackRange = upgradedStats.attackRange;
  base.passiveIncome = upgradedStats.passiveIncome;
  
  broadcast({
    type: 'event',
    event: 'base_upgraded',
    teamId: player.teamId,
    playerName: player.name
  });
  
  console.log(`🏰 ${player.name} kupił upgrade bazy za ${cost} złota`);
}

function handleMove(clientId, unitId, x, y) {
  const unit = gameState.units[unitId];
  const player = gameState.players[clientId];
  
  if (!unit || !player || unit.teamId !== player.teamId) return;

  const maxMove = 1500;
  const dist = distance(unit.x, unit.y, x, y);
  if (dist > maxMove) return;

  unit.targetX = Math.max(0, Math.min(CANVAS_WIDTH, x));
  unit.targetY = Math.max(0, Math.min(CANVAS_HEIGHT, y));
  
  if (unit.type === 'worker') {
    unit.state = 'idle';
    unit.miningTarget = null;
    unit.autoMining = false;
  }
}

function handleMine(clientId, unitId, mineId) {
  const unit = gameState.units[unitId];
  const player = gameState.players[clientId];
  const mine = gameState.goldMines.find(m => m.id === mineId);
  
  if (!unit || !player || !mine || unit.teamId !== player.teamId || unit.type !== 'worker') return;

  if (mine.depleted) {
    console.log(`⚠️ Kopalnia ${mineId} jest wyczerpana`);
    return;
  }

  unit.state = 'moving_to_mine';
  unit.miningTarget = mineId;
  unit.autoMining = true;
  
  const freeSpot = findFreeSpotAroundMine(mine, unit);
  unit.targetX = freeSpot.x;
  unit.targetY = freeSpot.y;
}

function gameTick() {
  gameState.tick++;
  
  if (!gameState.gameStarted) {
    if (gameState.tick % 3 === 0) {
      broadcastSnapshot();
    }
    return;
  }

  Object.values(gameState.buildings).forEach(building => {
    if (building.type !== 'base' || building.health <= 0) return;
    
    building.passiveTimer++;
    if (building.passiveTimer >= UNIT_STATS.base.passiveInterval) {
      building.passiveTimer = 0;
      const player = Object.values(gameState.players).find(p => p.baseId === building.id);
      if (player) {
        player.gold += building.passiveIncome;
        console.log(`💰 ${player.name} otrzymał ${building.passiveIncome}💰 z bazy`);
      }
    }
  });

  Object.values(gameState.units).forEach(unit => {
    const dx = unit.targetX - unit.x;
    const dy = unit.targetY - unit.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > unit.speed) {
      unit.x += (dx / dist) * unit.speed;
      unit.y += (dy / dist) * unit.speed;
    }
    
    handleCollisions(unit);

    if (unit.type === 'worker') {
      const player = Object.values(gameState.players).find(p => p.teamId === unit.teamId);
      if (!player) return;

      const base = gameState.buildings[player.baseId];
      if (!base) return;

      if (unit.carryingGold > 0 && distance(unit.x, unit.y, base.x, base.y) < 100) {
        player.gold += unit.carryingGold;
        unit.carryingGold = 0;
        
        if (unit.autoMining && unit.miningTarget) {
          const mine = gameState.goldMines.find(m => m.id === unit.miningTarget);
          if (mine && !mine.depleted) {
            unit.state = 'moving_to_mine';
            const freeSpot = findFreeSpotAroundMine(mine, unit);
            unit.targetX = freeSpot.x;
            unit.targetY = freeSpot.y;
          } else {
            unit.state = 'idle';
            unit.miningTarget = null;
            unit.autoMining = false;
          }
        } else {
          unit.state = 'idle';
          unit.miningTarget = null;
        }
      }

      if (unit.state === 'moving_to_mine' && unit.miningTarget) {
        const mine = gameState.goldMines.find(m => m.id === unit.miningTarget);
        if (mine && !mine.depleted && distance(unit.x, unit.y, mine.x, mine.y) < 60) {
          unit.state = 'mining';
          unit.miningProgress = 0;
        }
      } else if (unit.state === 'mining') {
        const mine = gameState.goldMines.find(m => m.id === unit.miningTarget);
        
        if (!mine || mine.depleted) {
          unit.state = 'idle';
          unit.miningTarget = null;
          unit.autoMining = false;
          return;
        }
        
        unit.miningProgress++;
        if (unit.miningProgress >= UNIT_STATS.worker.miningTime) {
          const goldToTake = Math.min(unit.maxGold, mine.remainingGold);
          unit.carryingGold = goldToTake;
          mine.remainingGold -= goldToTake;
          
          if (mine.remainingGold <= 0) {
            mine.depleted = true;
            broadcast({
              type: 'event',
              event: 'mine_depleted',
              mineId: mine.id,
              mineType: mine.type
            });
            console.log(`⛏️ Kopalnia ${mine.id} (${mine.type}) została wyczerpana`);
          }
          
          unit.state = 'returning';
          unit.targetX = base.x;
          unit.targetY = base.y;
        }
      }
    }

    if (unit.type === 'knight' || unit.type === 'champion') {
      if (unit.attackCooldown > 0) {
        unit.attackCooldown--;
      }

      let nearestEnemy = null;
      let minDist = Infinity;

      Object.values(gameState.units).forEach(other => {
        if (other.teamId !== unit.teamId && other.health > 0) {
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

      const aggroRadius = 200;
      const inAggroRange = nearestEnemy && minDist <= aggroRadius;
      const inAttackRange = nearestEnemy && minDist <= unit.attackRange;

      if (inAttackRange) {
        unit.target = nearestEnemy.id;
        unit.targetX = unit.x;
        unit.targetY = unit.y;
        
        if (unit.attackCooldown === 0) {
          nearestEnemy.health -= unit.damage;
          unit.attackCooldown = unit.type === 'champion' ? UNIT_STATS.champion.attackSpeed : UNIT_STATS.knight.attackSpeed;

          broadcast({
            type: 'event',
            event: 'attack',
            attackerId: unit.id,
            targetId: nearestEnemy.id,
            damage: unit.damage
          });

          if (nearestEnemy.health <= 0) {
            if (nearestEnemy.type === 'knight' || nearestEnemy.type === 'champion' || nearestEnemy.type === 'worker') {
              delete gameState.units[nearestEnemy.id];
              broadcast({
                type: 'event',
                event: 'unit_died',
                unitId: nearestEnemy.id
              });
            } else if (nearestEnemy.type === 'base') {
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
      } else if (inAggroRange) {
        const isMovingToTarget = distance(unit.targetX, unit.targetY, nearestEnemy.x, nearestEnemy.y) < 50;
        if (!isMovingToTarget) {
          unit.targetX = nearestEnemy.x;
          unit.targetY = nearestEnemy.y;
          unit.target = nearestEnemy.id;
        }
      } else {
        unit.target = null;
      }
    }
  });

  Object.values(gameState.buildings).forEach(building => {
    if (building.type !== 'base' || building.health <= 0) return;

    if (building.attackCooldown > 0) {
      building.attackCooldown--;
    }

    let nearestKnight = null;
    let minDist = Infinity;

    Object.values(gameState.units).forEach(unit => {
      if ((unit.type === 'knight' || unit.type === 'champion') && 
          unit.teamId !== building.teamId && 
          unit.health > 0) {
        const d = distance(building.x, building.y, unit.x, unit.y);
        if (d < minDist && d <= building.attackRange) {
          minDist = d;
          nearestKnight = unit;
        }
      }
    });

    if (nearestKnight && building.attackCooldown === 0) {
      nearestKnight.health -= building.damage;
      building.attackCooldown = UNIT_STATS.base.attackSpeed;
      building.target = nearestKnight.id;

      broadcast({
        type: 'event',
        event: 'base_attack',
        buildingId: building.id,
        targetId: nearestKnight.id,
        damage: building.damage
      });

      if (nearestKnight.health <= 0) {
        delete gameState.units[nearestKnight.id];
        broadcast({
          type: 'event',
          event: 'unit_died',
          unitId: nearestKnight.id
        });
      }
    } else if (!nearestKnight) {
      building.target = null;
    }
  });

  checkGameOver();

  if (gameState.tick % 3 === 0) {
    broadcastSnapshot();
  }
}

function broadcastSnapshot() {
  const snapshot = {
    type: 'snapshot',
    tick: gameState.tick,
    gameStarted: gameState.gameStarted,
    units: Object.values(gameState.units),
    buildings: Object.values(gameState.buildings),
    players: Object.entries(gameState.players).map(([clientId, player]) => ({
      clientId,
      teamId: player.teamId,
      name: player.name,
      gold: player.gold,
      workerUpgraded: player.workerUpgraded
    })),
    goldMines: gameState.goldMines
  };

  broadcast(snapshot);
}

wss.on('connection', (ws) => {
  console.log('🔌 Nowe połączenie WebSocket');

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'join': {
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
          checkGameStart();
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
            case 'upgrade_workers':
              handleWorkerUpgrade(clientData.clientId);
              break;
            case 'upgrade_base':
              handleBaseUpgrade(clientData.clientId);
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
      
      const player = gameState.players[clientData.clientId];
      
      if (player && gameState.gameStarted) {
        const base = gameState.buildings[player.baseId];
        if (base) {
          base.health = 0;
          console.log(`💀 Baza gracza ${clientData.name} zniszczona (opuścił grę)`);
        }
        
        Object.keys(gameState.units).forEach(unitId => {
          if (gameState.units[unitId].teamId === player.teamId) {
            delete gameState.units[unitId];
          }
        });
        
        console.log(`🗑️ Usunięto jednostki gracza ${clientData.name}`);
      }
      
      delete gameState.players[clientData.clientId];
      clients.delete(ws);

      broadcast({
        type: 'event',
        event: 'player_left',
        teamId: clientData.teamId,
        name: clientData.name
      });

      broadcastSnapshot();
      
      const playerCount = Object.keys(gameState.players).length;
      if (gameState.gameStarted && playerCount < gameState.minPlayersToStart) {
        gameState.gameStarted = false;
        broadcast({
          type: 'event',
          event: 'game_paused',
          message: '⏸️ Gra wstrzymana - czekam na więcej graczy...'
        });
        console.log('⏸️ Gra wstrzymana - za mało graczy');
      }
      
      checkGameOver();
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });
});

setInterval(gameTick, TICK_INTERVAL);

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║  🎮 RTS MULTIPLAYER SERVER v0.8 BETA              ║
║  Port: ${PORT}                                    ║
║  Tick Rate: ${TICK_RATE} Hz (${TICK_INTERVAL.toFixed(1)}ms)              ║
║  Max Players: 4 (1v1v1v1)                         ║
║  Map: ${CANVAS_WIDTH}x${CANVAS_HEIGHT}                             ║
║  NEW: Auto-Mining, Better Collisions              ║
╚════════════════════════════════════════════════════╝
  `);
});
