/* Modrinth catalog client shared by the Modrinth Mod Browser and Modrinth Plugin Browser.
 * Runs inside the Fledge plugin sandbox (QuickJS): no Node APIs, only the `host` object.
 * API reference: https://docs.modrinth.com/api/ */
var Modrinth = (function () {
  var API = 'https://api.modrinth.com/v2';
  var CHANNELS = { release: ['release'], beta: ['release', 'beta'], alpha: ['release', 'beta', 'alpha'] };
  var SORTS = { relevance: 1, downloads: 1, follows: 1, newest: 1, updated: 1 };

  function userAgent() {
    var contact = host.settings.contact ? '; ' + host.settings.contact : '';
    return 'Fledge/' + (host.context.panelVersion || 'dev') + ' (https://github.com/kavaliersdelikt/fledge' + contact + ')';
  }
  function query(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v)));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }
  async function call(path, params, init) {
    var res = await host.fetch(API + path + query(params), Object.assign({ headers: Object.assign({ 'user-agent': userAgent(), accept: 'application/json' }, init && init.headers) }, init && { method: init.method, body: init.body }));
    if (res.status === 429) throw new Error('Modrinth is rate limiting requests. Try again in ' + (res.headers['retry-after'] || 'a minute') + ' seconds.');
    if (res.status === 404) throw new Error('Not found on Modrinth');
    if (res.status < 200 || res.status >= 300) throw new Error('Modrinth answered ' + res.status);
    return res.json();
  }

  function pageSize() {
    var n = Number(host.settings.pageSize);
    return n >= 5 && n <= 50 ? Math.floor(n) : 24;
  }
  function allowedChannels() { return CHANNELS[host.settings.releaseChannel] || CHANNELS.release; }

  function normalizeFile(f) {
    return { url: f.url, filename: f.filename, sha512: f.hashes && f.hashes.sha512, sha1: f.hashes && f.hashes.sha1, size: f.size, primary: !!f.primary };
  }
  function normalizeVersion(v) {
    return {
      id: v.id, projectId: v.project_id, label: v.version_number, name: v.name, channel: v.version_type,
      publishedAt: v.date_published, gameVersions: v.game_versions || [], loaders: v.loaders || [], downloads: v.downloads || 0,
      changelog: typeof v.changelog === 'string' ? v.changelog.slice(0, 6000) : '',
      files: (v.files || []).map(normalizeFile),
      dependencies: (v.dependencies || []).map(function (d) { return { projectId: d.project_id || null, versionId: d.version_id || null, type: d.dependency_type, filename: d.file_name || null }; })
    };
  }
  function versionParams(target) {
    var p = {};
    if (target.loaders && target.loaders.length) p.loaders = target.loaders;
    if (target.gameVersion) p.game_versions = [target.gameVersion];
    return p;
  }
  function compatible(v, target) {
    var okLoader = !target.loaders || !target.loaders.length || (v.loaders || []).some(function (l) { return target.loaders.indexOf(l) >= 0; });
    var okGame = !target.gameVersion || (v.game_versions || []).indexOf(target.gameVersion) >= 0;
    return okLoader && okGame;
  }
  function primaryFile(files) {
    var jars = files.filter(function (f) { return /\.jar$/i.test(f.filename); });
    var pick = jars.filter(function (f) { return f.primary; })[0] || jars[0];
    return pick || null;
  }
  function describeTarget(target) {
    return (target.gameVersion ? 'Minecraft ' + target.gameVersion : 'this Minecraft version') + (target.loaders && target.loaders.length ? ' (' + target.loaders.join('/') + ')' : '');
  }

  function createProvider(cfg) {
    function requireKind(target) {
      if (!target || target.kind !== cfg.kind) throw new Error(cfg.name + ' only works with ' + cfg.noun + ' servers');
    }
    async function listVersions(projectId, target) {
      var list = await call('/project/' + encodeURIComponent(projectId) + '/version', versionParams(target));
      return list.filter(function (v) { return v.status === 'listed' || v.status === undefined; });
    }
    async function pickVersion(projectId, versionId, target) {
      if (versionId) {
        var v = await call('/version/' + encodeURIComponent(versionId));
        if (!compatible(v, target)) throw new Error('That version does not support ' + describeTarget(target));
        return v;
      }
      var channels = allowedChannels();
      var found = (await listVersions(projectId, target)).filter(function (v) { return channels.indexOf(v.version_type) >= 0; })[0];
      if (!found) throw new Error('No ' + channels.join('/') + ' version supports ' + describeTarget(target));
      return found;
    }

    return {
      async healthCheck() {
        // The API root redirects to the documentation site, so ask for a small tag list instead.
        var loaders = await call('/tag/loader');
        return { ok: true, message: 'Connected to Modrinth (' + loaders.length + ' loaders known)' };
      },

      async search(params, target) {
        requireKind(target);
        params = params || {};
        var facets = [['project_type:' + cfg.projectType]];
        if (target.loaders && target.loaders.length) facets.push(target.loaders.map(function (l) { return 'categories:' + l; }));
        if (target.gameVersion) facets.push(['versions:' + target.gameVersion]);
        if (cfg.serverSideOnly && !(params.showClientOnly === true || (params.showClientOnly === undefined && host.settings.showClientOnly))) facets.push(['server_side:required', 'server_side:optional']);
        (Array.isArray(params.categories) ? params.categories : []).slice(0, 5).forEach(function (c) { if (/^[a-z0-9-]{2,40}$/.test(c)) facets.push(['categories:' + c]); });
        var limit = Math.min(50, Math.max(1, Number(params.limit) || pageSize()));
        var res = await call('/search', {
          query: typeof params.query === 'string' ? params.query.slice(0, 100) : '',
          facets: facets,
          index: SORTS[params.sort] ? params.sort : 'relevance',
          offset: Math.max(0, Number(params.offset) || 0),
          limit: limit
        });
        return {
          total: res.total_hits || 0, offset: res.offset || 0, limit: res.limit || limit,
          items: (res.hits || []).map(function (h) {
            return {
              id: h.project_id, slug: h.slug, title: h.title, summary: h.description, iconUrl: h.icon_url || null, author: h.author,
              downloads: h.downloads || 0, follows: h.follows || 0, categories: (h.display_categories || h.categories || []).slice(0, 6),
              clientSide: h.client_side, serverSide: h.server_side, updatedAt: h.date_modified, url: 'https://modrinth.com/' + cfg.projectType + '/' + h.slug
            };
          })
        };
      },

      async categories(target) {
        requireKind(target);
        var list = await call('/tag/category');
        return list.filter(function (c) { return c.project_type === 'mod' && c.header === 'categories'; }).map(function (c) {
          return { id: c.name, label: c.name.replace(/(^|-)(\w)/g, function (m, a, b) { return (a ? ' ' : '') + b.toUpperCase(); }) };
        });
      },

      async project(projectId, target) {
        requireKind(target);
        var p = await call('/project/' + encodeURIComponent(projectId));
        return {
          id: p.id, slug: p.slug, title: p.title, summary: p.description, description: typeof p.body === 'string' ? p.body.slice(0, 60000) : '',
          iconUrl: p.icon_url || null, categories: (p.categories || []).concat(p.additional_categories || []).slice(0, 12), license: p.license ? (p.license.name || p.license.id) : null,
          clientSide: p.client_side, serverSide: p.server_side, downloads: p.downloads || 0, follows: p.followers || 0, updatedAt: p.updated, publishedAt: p.published,
          gallery: (p.gallery || []).slice(0, 8).map(function (g) { return { url: g.url, title: g.title || '' }; }),
          links: { page: 'https://modrinth.com/' + cfg.projectType + '/' + p.slug, source: p.source_url || null, issues: p.issues_url || null, wiki: p.wiki_url || null, discord: p.discord_url || null }
        };
      },

      async versions(projectId, target) {
        requireKind(target);
        return (await listVersions(projectId, target)).slice(0, 40).map(normalizeVersion);
      },

      async resolve(args, target) {
        requireKind(target);
        var projectId = args.projectId, versionId = args.versionId || null;
        if (!projectId && !versionId) throw new Error('A project or version is required');
        var v;
        if (!projectId) { v = await call('/version/' + encodeURIComponent(versionId)); projectId = v.project_id; if (!compatible(v, target)) throw new Error('That version does not support ' + describeTarget(target)); }
        else v = await pickVersion(projectId, versionId, target);
        var file = primaryFile(v.files || []);
        if (!file) throw new Error('This version has no downloadable .jar file');
        var project = await call('/project/' + encodeURIComponent(projectId));
        var n = normalizeVersion(v);
        return {
          project: { id: project.id, slug: project.slug, title: project.title, iconUrl: project.icon_url || null },
          version: { id: n.id, label: n.label, name: n.name, channel: n.channel, publishedAt: n.publishedAt },
          files: [normalizeFile(file)], dependencies: n.dependencies
        };
      },

      async updates(args, target) {
        requireKind(target);
        var items = (args && args.items || []).filter(function (i) { return i && i.sha512; }).slice(0, 60);
        if (!items.length) return [];
        var channels = allowedChannels();
        var body = { hashes: items.map(function (i) { return i.sha512; }), algorithm: 'sha512' };
        if (target.loaders && target.loaders.length) body.loaders = target.loaders;
        if (target.gameVersion) body.game_versions = [target.gameVersion];
        var latest = {};
        try { latest = await call('/version_files/update', null, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
        catch (e) { if (String(e.message).indexOf('Not found') < 0) throw e; }
        var out = [];
        for (var i = 0; i < items.length; i++) {
          var item = items[i], v = latest[item.sha512];
          if (v && channels.indexOf(v.version_type) < 0) {
            // The newest build is outside the allowed release channels: look for the newest allowed one.
            var list = (await listVersions(item.projectId, target)).filter(function (x) { return channels.indexOf(x.version_type) >= 0; });
            v = list[0] || null;
          }
          if (!v || v.id === item.versionId) continue;
          var file = primaryFile(v.files || []);
          if (!file) continue;
          out.push({ projectId: item.projectId, currentVersionId: item.versionId, latest: normalizeVersion(v) });
        }
        return out;
      }
    };
  }
  return { createProvider: createProvider };
})();
