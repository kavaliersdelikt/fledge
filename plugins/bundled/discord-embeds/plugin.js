// Better Discord Notifications for Fledge. Runs inside the plugin sandbox: no network, no Node.
// It only turns a notification into the JSON body of a Discord webhook message and returns it;
// Fledge checks the result (sizes, links, mentions) and sends it. See api/src/notification-styles.ts.
(function () {
  var EMOJI = {
    'server.crashed': '💥', 'server.crashloop': '🔁', 'server.recovered': '✅', 'server.disk_high': '💾',
    'backup.failed': '🗄️', 'backup.verification_failed': '🧪', 'schedule.failed': '⏰', 'addon.failed': '🧩',
    'failover.started': '🛟', 'failover.blocked': '🚧', 'node.offline': '📡', 'node.online': '🟢',
    'agent.update_failed': '⬆️', 'update.available': '🆕', 'plugin.disabled': '🔌', 'signup.pending': '👤',
    'billing.fulfilment_failed': '📦', 'billing.payment_failed': '💳', 'billing.dispute': '⚖️', 'billing.health': '🩺',
    'test': '🧪'
  };
  var BY_SEVERITY = { bad: '🔴', warn: '🟠', ok: '🟢', info: '🔵' };
  var LABEL = { bad: 'Needs attention', warn: 'Warning', ok: 'Recovered', info: 'Information' };
  var PAGES = { 'node.offline': '/nodes', 'node.online': '/nodes', 'agent.update_failed': '/nodes', 'update.available': '/', 'plugin.disabled': '/plugins', 'signup.pending': '/customers' };

  function setting(key, fallback) {
    var v = host.settings[key];
    return v === undefined || v === null || v === '' ? fallback : v;
  }
  function color(severity) {
    var key = { bad: 'colorBad', warn: 'colorWarn', ok: 'colorOk', info: 'colorInfo' }[severity] || 'colorInfo';
    var fallback = { colorBad: 'ED4245', colorWarn: 'F0B232', colorOk: '3BA55D', colorInfo: '5865F2' }[key];
    var hex = String(setting(key, fallback)).replace('#', '');
    var n = parseInt(hex, 16);
    return /^[0-9a-fA-F]{6}$/.test(hex) ? n : parseInt(fallback, 16);
  }
  function clip(text, max) {
    text = String(text == null ? '' : text);
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }
  // "oomKilled" -> "Oom killed"; "exit.code" -> "Exit code"
  function pretty(key) {
    var words = String(key).replace(/[._]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  function scalar(v) {
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'number' && isFinite(v)) return String(v);
    if (typeof v === 'string' && v && v.length <= 200) return v;
    return null;
  }
  // Up to six simple facts from the event's data. Ids, internal markers and the exit object (shown on its own) are left out.
  function dataFields(data) {
    var out = [];
    function walk(obj, prefix, depth) {
      Object.keys(obj || {}).forEach(function (k) {
        if (out.length >= 6) return;
        if (/(^|\.)(id|dedupe|test|jobId|logTail)$/i.test(prefix + k) || /Id$/.test(k) || k === 'exit') return;
        var v = obj[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && depth < 1) return walk(v, prefix + k + '.', depth + 1);
        var s = scalar(v);
        if (s !== null) out.push({ name: pretty(prefix + k), value: s, inline: true });
      });
    }
    walk(data, '', 0);
    return out;
  }
  function link(input, e) {
    if (setting('showLinks', true) === false) return undefined;
    var base = String(input.panelUrl || '').replace(/\/$/, '');
    if (!/^https?:\/\//.test(base)) return undefined;
    if (e.server && e.server.id) return base + '/servers/' + encodeURIComponent(e.server.id);
    if (/^billing\./.test(e.kind) && input.scope === 'panel') return base + '/billing';
    if (e.kind === 'server.crashed' || !PAGES[e.kind]) return base + '/';
    if (input.scope !== 'panel') return base + '/';
    return base + PAGES[e.kind];
  }
  // The first paragraph is the message; whatever follows is console output, shown as a code block.
  function split(body) {
    body = String(body || '').trim();
    var at = body.indexOf('\n\n');
    if (at < 0) return { text: body, tail: '' };
    return { text: body.slice(0, at).trim(), tail: body.slice(at + 2).trim() };
  }
  function fence(text, max) {
    var clean = String(text).replace(/```/g, "'''");
    var room = max - 8;
    if (clean.length > room) clean = '…' + clean.slice(clean.length - room + 1);
    return '```\n' + clean + '\n```';
  }

  function mentions(input, e) {
    var role = String(setting('pingRoleId', ''));
    var when = setting('pingWhen', 'bad');
    if (input.scope !== 'panel' || !/^\d{17,20}$/.test(role) || when === 'never') return null;
    if (e.severity === 'bad' || (when === 'warn' && e.severity === 'warn')) return role;
    return null;
  }

  function formatNotification(input) {
    var e = input.event || {};
    var style = input.style === 'compact' ? 'compact' : 'embed';
    var sev = BY_SEVERITY[e.severity] ? e.severity : 'info';
    var emoji = setting('showEmoji', true) === false ? '' : (EMOJI[e.kind] || BY_SEVERITY[sev]) + ' ';
    var brand = String(setting('botName', '') || input.brand || 'Fledge');
    var parts = split(e.body);
    var url = link(input, e);
    var embed = { color: color(sev) };
    var out = { username: clip(brand, 80) };
    var avatar = setting('avatarUrl', '');
    if (avatar) out.avatar_url = String(avatar);
    if (setting('showTimestamp', true) !== false) embed.timestamp = e.at || undefined;

    if (style === 'compact') {
      embed.description = clip('**' + emoji + clip(e.title, 180) + '**' + (e.server ? ' · ' + clip(e.server.name, 60) : '') + (parts.text ? '\n' + clip(parts.text, 600) : ''), 900);
      if (url) embed.url = url;
    } else {
      embed.author = { name: clip(brand, 100) };
      embed.title = clip(emoji + e.title, 250);
      if (url) embed.url = url;
      if (parts.text) embed.description = clip(parts.text, 1800);
      var fields = [];
      if (e.server) fields.push({ name: 'Server', value: clip(e.server.name, 200), inline: true });
      fields.push({ name: 'Status', value: LABEL[sev], inline: true });
      var exit = e.data && e.data.exit;
      if (exit && typeof exit === 'object') {
        if (exit.code !== undefined && exit.code !== null) fields.push({ name: 'Exit code', value: String(exit.code), inline: true });
        if (exit.oomKilled) fields.push({ name: 'Cause', value: 'Out of memory', inline: true });
        else if (exit.signal) fields.push({ name: 'Signal', value: clip(exit.signal, 40), inline: true });
      }
      dataFields(e.data).forEach(function (f) { if (fields.length < 9) fields.push(f); });
      if (parts.tail && setting('showLogTail', true) !== false) fields.push({ name: 'Last output', value: fence(parts.tail, 1000), inline: false });
      embed.fields = fields;
      var foot = setting('showEventCode', true) === false ? brand : brand + ' · ' + e.kind;
      embed.footer = { text: clip(foot, 200) };
    }
    out.embeds = [embed];
    var role = mentions(input, e);
    if (role) {
      out.content = '<@&' + role + '>';
      out.allowed_mentions = { parse: [], roles: [role] };
    }
    return out;
  }

  globalThis.fledgePlugin = { formatNotification: formatNotification };
})();
