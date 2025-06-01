import express from 'express';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import cookieParser from 'cookie-parser';
import { v4 as uuidv4 } from 'uuid';
import Player from './models/Player';

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, {
  cors: {
    origin: '*',
  }
});

app.use(express.static('public')); // if you have a front-end build
app.use(cookieParser());

// Store active players
const players = new Map();

app.use((req, res, next) => {
  if (!req.cookies.session) {
    const sessionId = uuidv4();
    res.cookie('session', sessionId);
  }
  next();
});

// REST route to get session
app.get('/session', (req, res) => {
  res.json({ session: req.cookies.session });
});

// Handle Socket.IO
io.on('connection', (socket) => {
  let sessionId;

  // Handle player join
  socket.on('player:join', (data) => {
    sessionId = data.session;
    players.set(sessionId, { name: data.name, socket });
    console.log(`${data.name} joined (session: ${sessionId})`);
  });

  // Handle missile launch
  socket.on('missile:launch', (data) => {
    // Broadcast to all except sender
    socket.broadcast.emit('missile:launched', {
      session: sessionId,
      missileData: data
    });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    players.delete(sessionId);
    console.log(`Player with session ${sessionId} disconnected`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
