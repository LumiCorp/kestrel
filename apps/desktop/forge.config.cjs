const { MakerZIP } = require("@electron-forge/maker-zip");

module.exports = {
  packagerConfig: {
    asar: false,
  },
  makers: [
    new MakerZIP({}, ["darwin", "linux", "win32"]),
  ],
};
