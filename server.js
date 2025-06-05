import express from 'express';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import cookieParser from 'cookie-parser';
import { v4 as uuidv4 } from 'uuid';
import Player from './models/Player.js';
import cors from 'cors';
import * as THREE from 'three';


const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, {
  cors: {
    // Dynamically set origin based on request.header.origin
    // This allows credentials to be sent with any origin.
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // Allow requests with no origin (e.g., same-origin, file://)
      return callback(null, origin); // Reflect the request origin
    },
    credentials: true, // Allow cookies and other credentials
  },
});

app.use(express.static('public'));
app.use(cors({
  // Dynamically set origin based on request.header.origin
  // This allows credentials to be sent with any origin.
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // Allow requests with no origin (e.g., same-origin, file://)
    return callback(null, origin); // Reflect the request origin
  },
  credentials: true, // Allow cookies and other credentials
}));
app.use(cookieParser());

const takenStates = new Set();
const players = new Map();
const missiles = [];
let gameStarted = false;

// Middleware to assign a session ID if one doesn't exist
app.use((req, res, next) => {
  if (!req.cookies.session) {
    const sessionId = uuidv4();
    res.cookie('session', sessionId, {
      httpOnly: false, // Allow JS access if needed
      secure: false,   // Set to true if using HTTPS
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60,
    });
    req.cookies.session = sessionId;
  }
  next();
});

// REST route to get the current session ID
app.get('/session', (req, res) => {
  const sessionId = req.cookies.session;
  res.json({ session: sessionId });
});


const missileUpdatesPerSecond = 60;
const missileUpdateInterval = 1000 / missileUpdatesPerSecond;
const gravity = 9.8; // Adjust as needed
const radius = 2; // Globe radius

function sphericalToCartesian(startLatLon, radius) {
  const [lat, lon] = startLatLon;
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);

  const x = -radius * Math.sin(phi) * Math.cos(theta);
  const y = radius * Math.cos(phi);
  const z = radius * Math.sin(phi) * Math.sin(theta);

  return new THREE.Vector3(x, y, z);
}

function computeVelocityVector(launchPoint, velocityMagnitude, azimuthDeg, elevationDeg, startLon) {
  const up = launchPoint.clone().normalize();

  // console.log(startLon)

  // Global Z-axis
  const globalZ = new THREE.Vector3(0, 0, 1);

  // North vector: project global Z onto the tangent plane at launchPoint
  const north = globalZ.clone().sub(up.clone().multiplyScalar(globalZ.dot(up))).normalize();

  // East vector: perpendicular to both up and north
  const east = new THREE.Vector3().crossVectors(north, up).normalize();

  // Convert angles to radians
  const azimuth = THREE.MathUtils.degToRad(azimuthDeg+94-startLon); // 94...
  const elevation = THREE.MathUtils.degToRad(elevationDeg);

  const vHorizontal = velocityMagnitude * Math.cos(elevation);
  const vVertical = velocityMagnitude * Math.sin(elevation);

  const velocity = new THREE.Vector3();
  velocity.add(north.clone().multiplyScalar(vHorizontal * Math.cos(azimuth)));
  velocity.add(east.clone().multiplyScalar(vHorizontal * Math.sin(azimuth)));
  velocity.add(up.clone().multiplyScalar(vVertical));

  return velocity;
}

/////////////////////////////
/////////////////////////////
setInterval(() => {
  if (!gameStarted) return;
  missiles.forEach((missile, index) => {
    if (missile.exploded) return;

    // Update velocity with gravity
    const r = missile.position.length();
    const g = gravity / (r * r);
    const acceleration = missile.position.clone().normalize().multiplyScalar(-g);
    missile.velocity.add(acceleration.multiplyScalar(1 / missileUpdatesPerSecond));

    // Update position
    missile.position.add(missile.velocity.clone().multiplyScalar(1 / missileUpdatesPerSecond));

    // Check for collision with ground
    if (missile.position.lengthSq() < (0.98 * radius) ** 2) {
      missile.exploded = true;
    }

    // Check for collision with bases
    for (const [playerSession, { player, socket }] of players.entries()) {
      const hitBases = [];
      for (const [city, coords] of Object.entries(player.getBasesPositions())) {
        const basePos = sphericalToCartesian(coords, radius);
        const distance = missile.position.distanceTo(basePos);

        if (distance < 0.05*radius && missile.exploded && missile.session !== playerSession) {
          // missile.exploded = true;
          io.emit('missile:hitBase', {
            missileSession: missile.session,
            baseSession: playerSession,
            city: city,
            position: coords,
          });

          hitBases.push(city);

          console.log(`Base ${city} hit`);
        }
      }

      hitBases.forEach(city => player.deleteBase(city));

      if (hitBases.length) {
        const allBases = [...players.values()].flatMap(({ player }) =>
          Object.entries(player.getBasesPositions()).map(([cityName, coordinates]) => ({
            session: player.session,
            name: player.name,
            city: cityName,
            startLatLon: coordinates,
          }))
        );
        // Emit the list of all bases to all connected clients
        io.emit('player:allBases', allBases);
      }

      if (Object.keys(player.getBasesPositions()).length === 0) {
        players.delete(playerSession)
        // Send gameover to the player whose base was hit
        socket.emit('game:gameover', {
          message: 'All your bases were hit by a missile!',
        });
      }

      if (players.size === 1) {
        const [winner] = players.values();
        if (winner && winner.socket) {
          winner.socket.emit('game:win', { message: 'Congratulations! You won the game!' });
          console.log(`Player ${winner.player.name} won the game!`);
        }
      }
    }
  });

  // Remove exploded missiles
  for (let i = missiles.length - 1; i >= 0; i--) {
    if (missiles[i].exploded) {
      missiles.splice(i, 1);
    }
  }
}, missileUpdateInterval);
/////////////////////////////
/////////////////////////////


// Handle Socket.IO connections
io.on('connection', (socket) => {
  let sessionId; // Declare sessionId here to be accessible throughout the socket's lifecycle

  socket.emit('selection:takenStates', Array.from(takenStates));

  socket.on('selection:selectState', (stateName) => {
    if (takenStates.has(stateName)) {
      socket.emit('selection:selectionFailed', stateName);
    } else {
      takenStates.add(stateName);
      // Broadcast the updated taken states list
      io.emit('selection:takenStates', Array.from(takenStates));
    }
  });

  socket.on('whoami', (sessionId) => {
    console.log('Session ID:', sessionId);

    const result = players.get(sessionId)?.player
    if (result) {
      socket.emit('whoami:success', { name: result.name });
    }
  });

  // Event listener for when a player joins the game
  socket.on('player:join', (data) => {
    sessionId = data.session; // Get the session ID from the client data

    // Check if the player already exists
    if (!players.has(sessionId)) {
      // Create a new player instance if they don't exist
      const player = new Player(data.name, sessionId);
      players.set(sessionId, { player, socket }); // Store player instance and their socket
      console.log(`${data.name} joined with base ${player.basePosition} (session: ${sessionId})`);

      if (players.size > 1) {
        gameStarted = true;
      }

      // Emit to ALL clients that a new player has joined, including their base position
      io.emit('player:joined', {
        session: sessionId,
        name: data.name,
        basesPositions: player.getBasesPositions(),
      });
    } else {
      // If player exists, update their socket reference (e.g., after a reconnect)
      const existing = players.get(sessionId);
      existing.socket = socket;
      console.log(`Player with session ${sessionId} reconnected.`);
    }

    // Get the player object (either new or existing)
    const player = players.get(sessionId).player;

    // Emit the player's base position back to the joining player only
    socket.emit('player:basePosition', {
      session: sessionId,
      basesPositions: player.getBasesPositions(),
    });

    const allBases = [...players.values()].flatMap(({ player }) =>
      Object.entries(player.getBasesPositions()).map(([cityName, coordinates]) => ({
        session: player.session,
        name: player.name,
        city: cityName,
        startLatLon: coordinates,
      }))
    );
    // Emit the list of all bases to all connected clients
    io.emit('player:allBases', allBases);
  });

  // Event listener for when a missile is launched
  socket.on('missile:launch', (data) => {
    if (!players.has(sessionId)) return;
    const startLatLon = data.startLatLon;
    const position = sphericalToCartesian(startLatLon, radius);
    const initialVelocity = computeVelocityVector(position, data.initialVelocity[0], data.initialVelocity[1], data.initialVelocity[2], startLatLon[1]);

    const missileData = {
      session: sessionId,
      position,
      velocity: initialVelocity,
      exploded: false,
    };

    missiles.push(missileData);

    io.emit('missile:launched', {
      session: sessionId,
      missileData: data,
      name: players.get(sessionId).player.name,
    });

    console.log(`Missile launched by ${sessionId}`);
  });


  

  // Event listener for when a socket disconnects
  // socket.on('disconnect', () => {
  //   // Remove the player from the active players map
  //   // players.delete(sessionId);
  //   console.log(`Player with session ${sessionId} disconnected`);
  //   // Optionally, you might want to emit an event to all clients that a player disconnected
  //   io.emit('player:disconnected', { session: sessionId });
  // });
});

// Periodically broadcast all player bases for synchronization
setInterval(() => {
  const allBases = [...players.values()].flatMap(({ player }) =>
    Object.entries(player.getBasesPositions()).map(([cityName, coordinates]) => ({
      session: player.session,
      name: player.name,
      city: cityName,
      startLatLon: coordinates,
    }))
  );
  // Emit the list of all bases to all connected clients
  io.emit('player:allBases', allBases);
}, 10000);


// Define the port the server will listen on
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
