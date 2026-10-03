// A catalog plugin in about sixty lines. It reads one JSON file:
//
//   { "items": [ { "id": "hello-mod", "title": "Hello Mod", "summary": "Says hello.", "version": "1.2.0",
//                  "gameVersions": ["1.21.4"], "loaders": ["fabric"],
//                  "file": { "url": "https://downloads.example.org/hello-mod-1.2.0.jar",
//                            "sha512": "<128 hex characters>", "size": 12345 } } ] }

async function load() {
  const res = await host.fetch(host.settings.indexUrl);
  if (!res.ok) throw new Error('The catalog file answered ' + res.status);
  const body = await res.json();
  return Array.isArray(body.items) ? body.items : [];
}

// Does this entry fit the server? `target` describes it: { kind, loaders, gameVersion, type }.
function fits(item, target) {
  const loaderOk = !target.loaders || !target.loaders.length || item.loaders.some((l) => target.loaders.includes(l));
  const versionOk = !target.gameVersion || item.gameVersions.includes(target.gameVersion);
  return loaderOk && versionOk;
}

function summary(item) {
  return {
    id: item.id, slug: item.id, title: item.title, summary: item.summary || '', iconUrl: null, author: 'Tiny',
    downloads: 0, follows: 0, categories: [], clientSide: 'unknown', serverSide: 'required', updatedAt: null, url: null,
  };
}

function versionOf(item) {
  return {
    id: item.version, label: item.version, name: item.title + ' ' + item.version, channel: 'release', publishedAt: null,
    gameVersions: item.gameVersions, loaders: item.loaders, downloads: 0, changelog: '',
    files: [{ filename: item.file.url.split('/').pop(), size: item.file.size, primary: true }],
  };
}

globalThis.fledgePlugin = {
  async healthCheck() {
    const items = await load();
    return { ok: true, message: 'The catalog lists ' + items.length + ' mods.' };
  },

  async search(params, target) {
    const q = (params.query || '').toLowerCase();
    const all = (await load()).filter((i) => fits(i, target) && (i.title + ' ' + (i.summary || '')).toLowerCase().includes(q));
    const page = all.slice(params.offset, params.offset + params.limit).map(summary);
    return { total: all.length, offset: params.offset, limit: params.limit, items: page };
  },

  async categories() {
    return [];
  },

  async project(id) {
    const item = (await load()).find((i) => i.id === id);
    if (!item) throw new Error('No such mod: ' + id);
    return { ...summary(item), description: item.summary || '', license: null, publishedAt: null, gallery: [], links: {} };
  },

  async versions(id, target) {
    return (await load()).filter((i) => i.id === id && fits(i, target)).map(versionOf);
  },

  async resolve(args, target) {
    const item = (await load()).find((i) => i.id === args.projectId && fits(i, target));
    if (!item) throw new Error('This mod has no version for your server');
    return {
      project: { id: item.id, title: item.title, slug: item.id, iconUrl: null },
      version: { id: item.version, label: item.version, channel: 'release', publishedAt: null },
      files: [{ url: item.file.url, filename: item.file.url.split('/').pop(), sha512: item.file.sha512, size: item.file.size }],
      dependencies: [],
    };
  },

  async updates(args, target) {
    const items = await load();
    const out = [];
    for (const have of args.items) {
      const item = items.find((i) => i.id === have.projectId && fits(i, target));
      if (item && item.version !== have.versionId) out.push({ projectId: item.id, currentVersionId: have.versionId, latest: versionOf(item) });
    }
    return out;
  },
};
