// ============================================
// TESTOWY KLIENT DO SYMULACJI GRACZA
// ============================================
// Użycie: node test-client.js [nazwa_gracza] [url_serwera]

const WebSocket = require('ws');

const playerName = process.argv[2] || `TestPlayer${Math.floor(Math.random() * 1000)}`;
const serverUrl = process.argv[3] || 'ws://localhost:3001';

console.log(`🤖 Testowy klient: ${playerName}`);
console.log(`🔗 Łączenie z: ${serverUrl}\n`);

const ws = new WebSocket(serverUrl);

let clientId = null;
let teamId = null;
let myGold = 500;
let myUnits = [];

ws.on('open', () => {
  console.log('✅ Połączono z serwerem');
  
  // Dołącz do gry
  ws.send(JSON.stringify({
    type: 'join',
    name: playerName
  }));
});

ws.on('message', (data) => {
  const message = JSON.parse(data);
  
  switch (message.type) {
    case 'joined':
      clientId = message.clientId;
      teamId = message.teamId;
      console.log(`✅ Dołączono jako Team ${teamId + 1}`);
      console.log(`   Client ID: ${clientId}`);
      console.log(`   Spawn: (${message.spawn.x}, ${message.spawn.y})`);
      
      // Symulacja: produkuj robotnika co 5 sekund
      setInterval(() => {
        if (myGold >= 100) {
          console.log(`💰 Produkcja robotnika (Gold: ${myGold})`);
          ws.send(JSON.stringify({
            type: 'command',
            command: 'produce',
            payload: { unitType: 'worker' }
          }));
        }
      }, 5000);
      
      // Symulacja: produkuj rycerza co 10 sekund
      setInterval(() => {
        if (myGold >= 200) {
          console.log(`⚔️ Produkcja rycerza (Gold: ${myGold})`);
          ws.send(JSON.stringify({
            type: 'command',
            command: 'produce',
            payload: { unitType: 'knight' }
          }));
        }
      }, 10000);
      
      // Symulacja: wysyłaj robotników do kopalń
      setTimeout(() => {
        setInterval(() => {
          if (myUnits.length > 0) {
            const workers = myUnits.filter(u => u.type === 'worker');
            if (workers.length > 0) {
              const worker = workers[Math.floor(Math.random() * workers.length)];
              console.log(`👷 Wysyłam robotnika ${worker.id} do kopalni`);
              ws.send(JSON.stringify({
                type: 'command',
                command: 'mine',
                payload: {
                  unitId: worker.id,
                  mineId: 'mine-0' // Pierwsza kopalnia
                }
              }));
            }
          }
        }, 15000);
      }, 3000);
      
      break;
      
    case 'room_full':
      console.log('❌ Pokój pełny!');
      ws.close();
      process.exit(1);
      break;
      
    case 'snapshot':
      // Aktualizuj stan
      const myPlayer = message.players.find(p => p.clientId === clientId);
      if (myPlayer) {
        myGold = myPlayer.gold;
      }
      
      myUnits = message.units.filter(u => u.teamId === teamId);
      
      // Wyświetl status co 100 ticków (~3 sekundy)
      if (message.tick % 100 === 0) {
        console.log(`📊 Tick ${message.tick} | Gold: ${myGold} | Units: ${myUnits.length} (${myUnits.filter(u => u.type === 'worker').length}👷 + ${myUnits.filter(u => u.type === 'knight').length}⚔️)`);
      }
      break;
      
    case 'event':
      switch (message.event) {
        case 'player_joined':
          console.log(`👋 ${message.name} dołączył (Team ${message.teamId + 1})`);
          break;
        case 'player_left':
          console.log(`👋 ${message.name} opuścił grę`);
          break;
        case 'base_destroyed':
          console.log(`💀 Baza gracza ${message.playerName} zniszczona!`);
          break;
        case 'unit_produced':
          if (message.teamId === teamId) {
            console.log(`✅ Wyprodukowano: ${message.unitType}`);
          }
          break;
      }
      break;
      
    case 'game_over':
      console.log(`\n🏆 KONIEC GRY: ${message.message}`);
      if (message.winner === playerName) {
        console.log('🎉 WYGRAŁEŚ!');
      }
      break;
      
    case 'game_reset':
      console.log('🔄 Gra zresetowana');
      myGold = 500;
      myUnits = [];
      break;
  }
});

ws.on('error', (error) => {
  console.error('❌ WebSocket error:', error.message);
});

ws.on('close', () => {
  console.log('🔌 Rozłączono');
  process.exit(0);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Zamykanie...');
  ws.close();
});