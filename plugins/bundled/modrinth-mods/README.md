# Modrinth Mod Browser

Adds a **Mods** tab to Fabric, Quilt, Forge and NeoForge servers. Search [Modrinth](https://modrinth.com/mods), pick a version that matches the server's Minecraft version and loader, review dependencies and install in one click. Installed mods can be disabled, updated and removed from the same tab.

- Only the server side matters here: client-only mods are hidden unless you turn them on in this plugin's settings.
- Every file is downloaded by the node directly from `cdn.modrinth.com` and checked against Modrinth's SHA-512 before it is written.
- A server restart is needed before mods load or unload.

**Permissions:** reach `api.modrinth.com` and `cdn.modrinth.com`; read a server's game and version; add and remove files in a server's `mods` folder when you confirm an install.
