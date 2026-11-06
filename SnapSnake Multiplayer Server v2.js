/**
 * SnapSnake IO - Single-File Multiplayer Server (v2)
 * ===================================================
 * Now with 10+ power-ups guaranteed alive at all times!
 * 
 * QUICK START:
 * 1. Save this as server.js
 * 2. Run: npm install ws && node server.js
 * 3. Clients connect at: ws://YOUR_IP:8080
 * 
 * FREE HOSTING: Render.com / Railway.app / Fly.io / Glitch.com
 */

const http = require('http');
const { WebSocketServer } = require('ws');

// ============== CONFIGURATION ==============
const CONFIG = {
    port: process.env.PORT || 8080,
    worldSize: 6000,
    tickRate: 30,
    baseSpeed: 200,
    boostSpeed: 400,
    turnSpeed: 14,
    snakeRadius: 14,
    segmentSpacing: 5,
    initialScore: 12,
    maxFood: 800,
    maxPlayers: 100,
    powerupMin: 10,      // ← AT LEAST 10 POWER-UPS ALWAYS ALIVE
    powerupMax: 15
};

const FRUITS = [
    {e:'🍒',c:'#ff0044',v:1,r:6},{e:'🍎',c:'#ff3333',v:2,r:8},{e:'🍊',c:'#ff8800',v:2,r:8},
    {e:'🍉',c:'#ff3366',v:3,r:10},{e:'🍇',c:'#8800cc',v:2,r:8},{e:'🍍',c:'#ffcc00',v:3,r:10},
    {e:'🥝',c:'#88aa00',v:2,r:8},{e:'🍑',c:'#ffaa66',v:2,r:8},{e:'🍌',c:'#ffff44',v:4,r:11},
    {e:'🥕',c:'#ff6600',v:2,r:8},{e:'🥦',c:'#22aa22',v:3,r:9},{e:'🌽',c:'#ffdd44',v:3,r:9},
    {e:'🍆',c:'#6600cc',v:3,r:9},{e:'🥑',c:'#44aa44',v:4,r:10},{e:'🍋',c:'#ffff00',v:4,r:10}
];

// Power-ups with weighted rarity (server-authoritative)
const POWERUPS = [
    {t:'sprint',    i:'⚡', c:'#ff6600', dur:20000, weight:40},
    {t:'telescope', i:'🔭', c:'#9933ff', dur:20000, weight:35},
    {t:'feast',     i:'🍽️', c:'#00ffcc', dur:15000, weight:15},
    {t:'magnet',    i:'🧲', c:'#ff3399', dur:20000, weight:10}
];
const TOTAL_WEIGHT = POWERUPS.reduce((sum,p) => sum+p.weight, 0);

function pickWeightedPowerup() {
    let roll = Math.random() * TOTAL_WEIGHT;
    for(const p of POWERUPS) {
        roll -= p.weight;
        if(roll <= 0) return p;
    }
    return POWERUPS[0];
}

// ============== GAME STATE ==============
class World {
    constructor() {
        this.snakes = new Map();
        this.foods = [];
        this.powerups = [];
        this.nextPuId = 1;
        this.leaderboard = [];
        
        this.spawnFood(CONFIG.maxFood);
        // GUARANTEE: fill powerups immediately at boot
        this.maintainPowerups();
    }

    spawnFood(count) {
        for(let i = this.foods.length; i < count; i++) {
            const fruit = FRUITS[Math.floor(Math.random() * FRUITS.length)];
            this.foods.push({
                id: Math.random().toString(36).slice(2),
                x: Math.random() * CONFIG.worldSize,
                y: Math.random() * CONFIG.worldSize,
                ...fruit
            });
        }
    }

    spawnPowerup(x, y) {
        const p = pickWeightedPowerup();
        this.powerups.push({
            id: 'pu' + (this.nextPuId++),
            t: p.t, i: p.i, c: p.c, dur: p.dur,
            r: 16,
            x: x !== undefined ? x : Math.random() * CONFIG.worldSize,
            y: y !== undefined ? y : Math.random() * CONFIG.worldSize
        });
    }

    // GUARANTEE: keep 10-15 powerups alive at all times
    maintainPowerups(respawnX, respawnY) {
        while(this.powerups.length < CONFIG.powerupMin) {
            // When respawning after a pickup, 50% chance to spawn near the eater
            if(respawnX !== undefined && Math.random() < 0.5) {
                this.spawnPowerup(
                    respawnX + (Math.random()-0.5) * 1500,
                    respawnY + (Math.random()-0.5) * 1500
                );
            } else {
                this.spawnPowerup();
            }
        }
        if(this.powerups.length > CONFIG.powerupMax) {
            this.powerups.splice(CONFIG.powerupMax);
        }
        // Clamp everything inside world bounds
        for(const pu of this.powerups) {
            pu.x = Math.max(100, Math.min(CONFIG.worldSize-100, pu.x));
            pu.y = Math.max(100, Math.min(CONFIG.worldSize-100, pu.y));
        }
    }

    addPlayer(id, nickname, color) {
        const safeName = String(nickname || 'Anonymous')
            .replace(/[^\w\s\-_]/g, '')
            .slice(0, 15) || 'Anonymous';
        
        const snake = {
            id,
            nickname: safeName,
            color: color || '#' + Math.floor(Math.random()*16777215).toString(16),
            x: Math.random() * (CONFIG.worldSize - 400) + 200,
            y: Math.random() * (CONFIG.worldSize - 400) + 200,
            angle: Math.random() * Math.PI * 2,
            targetAngle: 0,
            score: CONFIG.initialScore,
            boosting: false,
            alive: true,
            buffs: {},        // active powerup buffs: {type: endTimeMs}
            segments: []
        };
        snake.targetAngle = snake.angle;

        for(let i = 0; i < CONFIG.initialScore; i++) {
            snake.segments.push({
                x: snake.x - Math.cos(snake.angle) * i * CONFIG.segmentSpacing,
                y: snake.y - Math.sin(snake.angle) * i * CONFIG.segmentSpacing
            });
        }

        this.snakes.set(id, snake);
        return snake;
    }

    removePlayer(id) {
        const snake = this.snakes.get(id);
        if(snake && snake.alive) this.killSnake(snake);
        this.snakes.delete(id);
    }

    killSnake(snake) {
        snake.alive = false;
        for(let i = 0; i < snake.segments.length; i += 2) {
            const seg = snake.segments[i];
            const fruit = FRUITS[Math.floor(Math.random() * FRUITS.length)];
            this.foods.push({
                ...fruit,
                x: seg.x + (Math.random() - 0.5) * 30,
                y: seg.y + (Math.random() - 0.5) * 30
            });
        }
    }

    hasBuff(snake, type) {
        return snake.buffs[type] && Date.now() < snake.buffs[type];
    }

    // ============== SERVER-SIDE PHYSICS ==============
    update(dt) {
        const now = Date.now();

        for(const snake of this.snakes.values()) {
            if(!snake.alive) continue;

            // Expire buffs
            for(const t in snake.buffs) {
                if(now >= snake.buffs[t]) delete snake.buffs[t];
            }

            // Smooth turning
            let diff = snake.targetAngle - snake.angle;
            while(diff > Math.PI) diff -= Math.PI*2;
            while(diff < -Math.PI) diff += Math.PI*2;
            
            const maxTurn = CONFIG.turnSpeed * dt;
            if(Math.abs(diff) < maxTurn) snake.angle = snake.targetAngle;
            else snake.angle += Math.sign(diff) * maxTurn;

            // Speed (sprint buff = 1.5x)
            let speed = CONFIG.baseSpeed;
            if(this.hasBuff(snake, 'sprint')) speed *= 1.5;
            if(snake.boosting && snake.score > 15) {
                speed = CONFIG.boostSpeed;
                snake.score -= 4 * dt;
            }

            snake.x += Math.cos(snake.angle) * speed * dt;
            snake.y += Math.sin(snake.angle) * speed * dt;

            snake.x = Math.max(CONFIG.snakeRadius, Math.min(CONFIG.worldSize - CONFIG.snakeRadius, snake.x));
            snake.y = Math.max(CONFIG.snakeRadius, Math.min(CONFIG.worldSize - CONFIG.snakeRadius, snake.y));

            snake.segments.unshift({x: snake.x, y: snake.y});
            const targetLen = Math.max(4, Math.floor(snake.score));
            while(snake.segments.length > targetLen) snake.segments.pop();
        }

        // Food consumption (magnet pulls food, feast doubles value)
        const eatRadius = CONFIG.snakeRadius + 8;
        for(const snake of this.snakes.values()) {
            if(!snake.alive) continue;
            const magnet = this.hasBuff(snake, 'magnet');
            const feast = this.hasBuff(snake, 'feast');
            for(let i = this.foods.length - 1; i >= 0; i--) {
                const food = this.foods[i];
                const dist = Math.hypot(snake.x - food.x, snake.y - food.y);
                if(magnet && dist < 250 && dist > 0.001) {
                    food.x += (snake.x - food.x) / dist * 6;
                    food.y += (snake.y - food.y) / dist * 6;
                }
                if(dist < eatRadius) {
                    snake.score += food.v * (feast ? 2 : 1);
                    this.foods.splice(i, 1);
                }
            }
        }

        // Powerup pickups (server-authoritative, instant respawn keeps 10+ alive)
        for(const snake of this.snakes.values()) {
            if(!snake.alive) continue;
            for(let i = this.powerups.length - 1; i >= 0; i--) {
                const pu = this.powerups[i];
                const dist = Math.hypot(snake.x - pu.x, snake.y - pu.y);
                if(dist < CONFIG.snakeRadius + pu.r + 8) {
                    snake.buffs[pu.t] = Date.now() + pu.dur;
                    // Notify the eater
                    const ws = [...wss.clients].find(c => c.playerId === snake.id);
                    if(ws && ws.readyState === 1) {
                        ws.send(JSON.stringify({type:'BUFF', t: pu.t, i: pu.i, c: pu.c, dur: pu.dur}));
                    }
                    this.powerups.splice(i, 1);
                    this.maintainPowerups(snake.x, snake.y);  // INSTANT respawn
                }
            }
        }

        // Snake collisions
        const snakesArray = [...this.snakes.values()].filter(s => s.alive);
        for(const a of snakesArray) {
            if(!a.alive) continue;
            for(const b of snakesArray) {
                if(a === b || !b.alive) continue;
                for(let i = 3; i < b.segments.length; i++) {
                    const seg = b.segments[i];
                    if(Math.hypot(a.x - seg.x, a.y - seg.y) < CONFIG.snakeRadius * 2.8) {
                        this.killSnake(a);
                        break;
                    }
                }
                if(!a.alive) break;
            }
        }

        // Refill food
        while(this.foods.length < CONFIG.maxFood) {
            const fruit = FRUITS[Math.floor(Math.random() * FRUITS.length)];
            this.foods.push({
                ...fruit,
                x: Math.random() * CONFIG.worldSize,
                y: Math.random() * CONFIG.worldSize
            });
        }

        // Safety net every tick
        this.maintainPowerups();

        // Leaderboard
        this.leaderboard = [...this.snakes.values()]
            .filter(s => s.alive)
            .sort((a,b) => b.score - a.score)
            .slice(0, 15)
            .map(s => ({id: s.id, nickname: s.nickname, score: Math.floor(s.score)}));
    }

    // ============== CLIENT SNAPSHOT ==============
    snapshotFor(playerSnake) {
        const VIEW_DIST = 2000;
        const nearby = [];

        for(const other of this.snakes.values()) {
            if(!other.alive) continue;
            const dx = other.x - playerSnake.x;
            const dy = other.y - playerSnake.y;
            if(dx*dx + dy*dy > VIEW_DIST*VIEW_DIST) continue;

            const step = other.segments.length > 200 ? 4 : other.segments.length > 100 ? 2 : 1;
            const segs = [];
            for(let i = 0; i < other.segments.length; i += step) {
                segs.push([Math.round(other.segments[i].x), Math.round(other.segments[i].y)]);
            }

            nearby.push({
                id: other.id,
                n: other.nickname,
                c: other.color,
                s: Math.floor(other.score),
                b: other.boosting ? 1 : 0,
                seg: segs
            });
        }

        const food = [];
        for(const f of this.foods) {
            const dx = f.x - playerSnake.x;
            const dy = f.y - playerSnake.y;
            if(dx*dx + dy*dy > VIEW_DIST*VIEW_DIST) continue;
            food.push([Math.round(f.x), Math.round(f.y), f.c, f.v, f.r, f.e]);
        }

        // All powerups (they matter globally - hunters travel for them)
        const pus = this.powerups.map(pu => ({
            id: pu.id, x: Math.round(pu.x), y: Math.round(pu.y),
            t: pu.t, i: pu.i, c: pu.c, r: pu.r
        }));

        return {
            type: 'STATE',
            you: {
                x: Math.round(playerSnake.x),
                y: Math.round(playerSnake.y),
                a: Number(playerSnake.angle.toFixed(3)),
                s: Math.floor(playerSnake.score)
            },
            snakes: nearby,
            food: food,
            powerups: pus,
            lb: this.leaderboard,
            count: this.snakes.size
        };
    }
}

// ============== SERVER SETUP ==============
const world = new World();

const server = http.createServer((req, res) => {
    if(req.url === '/stats') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({
            players: world.snakes.size,
            food: world.foods.length,
            powerups: world.powerups.length
        }));
        return;
    }
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('SnapSnake Server Running');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.playerId = Math.random().toString(36).slice(2, 10);
    ws.snake = null;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch(msg.type) {
            case 'JOIN':
                if(world.snakes.size >= CONFIG.maxPlayers) {
                    ws.send(JSON.stringify({type: 'ERROR', message: 'Server full'}));
                    ws.close();
                    return;
                }
                ws.snake = world.addPlayer(ws.playerId, msg.nickname, msg.color);
                ws.send(JSON.stringify({
                    type: 'WELCOME',
                    id: ws.playerId,
                    worldSize: CONFIG.worldSize
                }));
                break;

            case 'INPUT':
                if(!ws.snake || !ws.snake.alive) return;
                if(typeof msg.a === 'number' && isFinite(msg.a)) {
                    ws.snake.targetAngle = msg.a;
                }
                ws.snake.boosting = !!msg.b;
                break;

            case 'RESPAWN':
                if(!ws.snake || !ws.snake.alive) {
                    world.removePlayer(ws.playerId);
                    ws.snake = world.addPlayer(ws.playerId, msg.nickname || 'Anonymous', msg.color);
                }
                break;

            case 'PING':
                ws.send(JSON.stringify({type: 'PONG', t: msg.t}));
                break;
        }
    });

    ws.on('close', () => {
        if(ws.snake) world.removePlayer(ws.playerId);
    });
});

// Heartbeat
setInterval(() => {
    wss.clients.forEach(ws => {
        if(!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// Game tick
let lastTick = Date.now();
setInterval(() => {
    const now = Date.now();
    const dt = Math.min((now - lastTick) / 1000, 0.1);
    lastTick = now;

    world.update(dt);

    for(const ws of wss.clients) {
        if(ws.readyState !== 1) continue;
        if(!ws.snake) continue;

        if(!ws.snake.alive) {
            ws.send(JSON.stringify({
                type: 'DIED',
                score: Math.floor(ws.snake.score),
                leaderboard: world.leaderboard
            }));
            ws.snake = null;
            continue;
        }

        const snap = world.snapshotFor(ws.snake);
        ws.send(JSON.stringify(snap));
    }
}, 1000 / CONFIG.tickRate);

server.listen(CONFIG.port, () => {
    console.log('🐍 SnapSnake Server v2 started on port ' + CONFIG.port);
    console.log('   Players: ' + CONFIG.maxPlayers + ' | World: ' + CONFIG.worldSize + 'px');
    console.log('   Power-ups: ' + CONFIG.powerupMin + '-' + CONFIG.powerupMax + ' guaranteed alive at all times');
    console.log('   Stats: http://localhost:' + CONFIG.port + '/stats');
    
    if(process.env.PORT) {
        console.log('\n   🌐 DEPLOYED! Your server is LIVE.');
    }
});