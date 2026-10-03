globalThis.fledgePlugin = Modrinth.createProvider({
  name: 'The Modrinth Mod Browser',
  noun: 'mod-loader (Fabric, Quilt, Forge or NeoForge)',
  kind: 'mod',
  projectType: 'mod',
  // Most mods are client-only; servers only need the ones that support the server side.
  serverSideOnly: true
});
