# Modrinth Plugin Browser

Adds a **Plugins** tab to Paper, Purpur, Folia and Spigot servers. Search [Modrinth](https://modrinth.com/plugins), pick a version that matches the server's Minecraft version and software, review dependencies and install in one click. Installed plugins can be disabled, updated and removed from the same tab.

- Folia servers only see Folia-compatible plugins. Paper-compatible plugins are also offered on Purpur.
- Every file is downloaded by the node directly from `cdn.modrinth.com` and checked against Modrinth's SHA-512 before it is written.
- Most plugins need a server restart (or a plugin manager) to load or unload.

**Permissions:** reach `api.modrinth.com` and `cdn.modrinth.com`; read a server's game and version; add and remove files in a server's `plugins` folder when you confirm an install.
