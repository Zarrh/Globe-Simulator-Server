class Player {
  constructor(name, sessionId) {
    this.name = name;
    this.sessionId = sessionId;
    // base position stored in [lon, lat] format
    this.basePosition = [Math.random() * 360, Math.random() * 180 - 90];
  }

  getBasePosition() {
    return this.basePosition;
  }

  setBasePosition(lon, lat) {
    this.basePosition = [lon, lat];
  }
}

export default Player;
