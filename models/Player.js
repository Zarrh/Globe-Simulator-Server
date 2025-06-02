import { states } from "../data/data.js";

class Player {
  constructor(name, sessionId) {
    this.name = name;
    this.sessionId = sessionId;
    this.basePosition = states.find((state) => state.name === this.name)?.coordinates[0] ?? Player.randomBase();
  }

  static randomBase() {
    // Random longitude between -180 and 180
    const lon = Math.random() * 360 - 180;
    // Random latitude between -90 and 90
    const lat = Math.random() * 180 - 90;
    return [lat, lon];
  }

  getBasePosition() {
    return this.basePosition;
  }
}

export default Player;