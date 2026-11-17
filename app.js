/*
 * Ônibus do Rio ao vivo
 * Mapa com a posição dos ônibus de uma linha (feed GTFS-Realtime da SMTR) e
 * histórico de tempos de viagem (viagens.json, gerado por preprocessar.py).
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------ configuração */
  var CONFIG = {
    // Para usar um servidor intermediário (ver README, seção CORS), troque este endereço.
    //feedUrl: 'https://gpsrioonibus.hcboaro.workers.dev/',
    feedUrl: (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
     ? '/feed'
     : 'https://gpsrioonibus.hcboaro.workers.dev',
    refreshMs: 30000,       // intervalo entre atualizações
    staleSec: 300,          // acima disso o carro é mostrado como "sem sinal"
    feedOldSec: 180,        // acima disso o feed inteiro é considerado parado
    fetchTimeoutMs: 25000,
    center: [-22.92, -43.45],
    zoom: 11,
    tz: 'America/Sao_Paulo'
  };

  /* ---------------------------------------------------------------- utilidades */
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    q: $('q'), form: $('search-form'), suggest: $('suggest'), theme: $('theme'),
    sheet: $('sheet'), drag: $('drag'), grip: $('grip'), sign: $('sign'), routes: $('routes'),
    status: $('status'), progress: $('progress'),
    tabs: $('tabs'), tabNow: $('tab-now'), tabTrip: $('tab-trip'),
    body: $('body'), panelEmpty: $('panel-empty'), panelNow: $('panel-now'), panelTrip: $('panel-trip'),
    toast: $('toast')
  };
  var desktopMQ = matchMedia('(min-width: 900px)');
  var reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function normalize(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function squash(s) { return String(s).toUpperCase().replace(/\s+/g, ''); }

  var clockFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: CONFIG.tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  function fmtClock(ms) { return clockFmt.format(new Date(ms)); }
  function fmtAge(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + ' s';
    if (sec < 3600) return Math.round(sec / 60) + ' min';
    return Math.floor(sec / 3600) + ' h ' + pad2(Math.round((sec % 3600) / 60)) + ' min';
  }
  function fmtKm(m) { return (m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' km'; }
  function mmss(sec) { return pad2(Math.floor(sec / 60)) + ':' + pad2(Math.round(sec % 60)); }
  function fmtDur(min) {
    min = Math.round(min);
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60), m = min % 60;
    return h + ' h' + (m ? ' ' + pad2(m) + ' min' : '');
  }
  function fmtTick(min) {
    if (min < 60) return String(min);
    var h = Math.floor(min / 60), m = min % 60;
    return h + 'h' + (m ? pad2(m) : '');
  }
  function fmtDate(iso) { var p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso; }
  function currentHour() {
    return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date()), 10) % 24;
  }
  function pickTipoDia(tipos) {
    var wd = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.tz, weekday: 'short' }).format(new Date());
    var want = wd === 'Sun' ? 'dom' : wd === 'Sat' ? 'sab' : 'util';
    return tipos.filter(function (t) { return normalize(t).indexOf(want) >= 0; })[0] || tipos[0];
  }

  var toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, 3800);
  }

  /* -------------------------------------------------------------------- estado */
  var S = {
    itins: null, viagens: null, keys: [], keyIndex: {},
    linha: null, trechos: [], bounds: null,
    feed: null, vehicles: [], lastOk: null, fetching: false, error: null, timer: null,
    hidden: { 0: false, 1: false },
    tab: 'now', tipoDia: null, sentido: 0, hora: null,
    snap: 'peek', vis: 200, theme: 'light', signIdx: 0, signTimer: null
  };

  /* ---------------------------------------------------------------------- mapa */
  var map = L.map('map', { zoomControl: false, zoomSnap: 0.5 }).setView(CONFIG.center, CONFIG.zoom);
  L.control.zoom({ position: 'bottomright', zoomInTitle: 'Aproximar', zoomOutTitle: 'Afastar' }).addTo(map);
  map.attributionControl.setPrefix(false);
  var ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  var OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  var tiles = {
  light: L.tileLayer(OSM, { maxZoom: 19, attribution: ATTR }),
  dark:  L.tileLayer(OSM, { maxZoom: 19, attribution: ATTR, className: 'tiles-dark' })
  };
  var routeGroup = L.layerGroup().addTo(map);
  var routeLayers = [];
  var busLayer = L.layerGroup().addTo(map);
  var markers = new Map();

  /* ---------------------------------------------------------------------- tema */
  function applyTheme(t, persist) {
    S.theme = t;
    document.documentElement.setAttribute('data-theme', t);
    var other = t === 'dark' ? 'light' : 'dark';
    if (map.hasLayer(tiles[other])) map.removeLayer(tiles[other]);
    if (!map.hasLayer(tiles[t])) tiles[t].addTo(map);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', css('--bg'));
    routeLayers.forEach(function (r) {
      r.casing.setStyle({ color: css('--casing') });
      r.line.setStyle({ color: dirColor(r.dir) });
    });
    if (persist) { try { localStorage.setItem('theme', t); } catch (e) { /* sem armazenamento */ } }
  }

  /* -------------------------------------------------------------- trajetos */
  function dirColor(i) { return i === 0 ? css('--ida') : i === 1 ? css('--volta') : css('--muted'); }

  function drawRoute() {
    routeGroup.clearLayers();
    routeLayers = [];
    var all = [];
    S.trechos.forEach(function (t, i) {
      var lines = (t.linhas || []).map(function (l) {
        return l.map(function (p) { all.push([p[1], p[0]]); return [p[1], p[0]]; });
      });
      var base = { lineJoin: 'round', lineCap: 'round', interactive: false };
      routeLayers.push({
        dir: i,
        casing: L.polyline(lines, Object.assign({ color: css('--casing'), weight: 9, opacity: 0.95 }, base)),
        line: L.polyline(lines, Object.assign({ color: dirColor(i), weight: 5, opacity: 0.95 }, base))
      });
    });
    syncRouteVisibility();
    S.bounds = all.length ? L.latLngBounds(all) : null;
  }

  function syncRouteVisibility() {
    routeGroup.clearLayers();
    routeLayers.forEach(function (r) {
      if (!S.hidden[r.dir]) { routeGroup.addLayer(r.casing); routeGroup.addLayer(r.line); }
    });
  }

  function fitLine() {
    if (!S.bounds) return;
    var d = desktopMQ.matches;
    // painel quase em tela cheia: não sobra mapa para enquadrar
    if (!d && map.getSize().y - 84 - (S.vis + 24) < 120) return;
    map.fitBounds(S.bounds, {
      paddingTopLeft: d ? [440, 84] : [24, 84],
      paddingBottomRight: d ? [24, 24] : [24, S.vis + 24],
      maxZoom: 16,
      animate: !reduceMotion
    });
  }

  /* ------------------------------------------------------------ veículos */
    var GEO = { maxDist: 80, minSpeed: 3, maxAngle: 70, tie: 15 };

  function angDiff(a, b) { var d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

  // melhor segmento do trajeto (o mais próximo) cujo rumo difere do rumo do carro em até maxAngle
  function nearestAligned(v, linhas) {
    var kx = Math.cos(v.lat * Math.PI / 180) * 111320, ky = 110540, best = null;
    for (var j = 0; j < linhas.length; j++) {
      var l = linhas[j];
      for (var k = 0; k + 1 < l.length; k++) {
        var ax = (l[k][0] - v.lon) * kx, ay = (l[k][1] - v.lat) * ky;
        var bx = (l[k + 1][0] - v.lon) * kx, by = (l[k + 1][1] - v.lat) * ky;
        var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        if (len2 === 0) continue;
        var t = clamp(-(ax * dx + ay * dy) / len2, 0, 1);
        var px = ax + t * dx, py = ay + t * dy, dist = Math.sqrt(px * px + py * py);
        if (dist > GEO.maxDist || (best && dist >= best.dist)) continue;
        var brg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
        var ad = angDiff(brg, v.bearing);
        if (ad <= GEO.maxAngle) best = { dist: dist, ang: ad };
      }
    }
    return best;
  }

  // 0 ou 1 pelo trajeto; null quando o carro está parado, sem rumo, longe do trajeto ou ambíguo
  function geoDir(v) {
    if (v.bearing == null || v.speedKmh == null || v.speedKmh < GEO.minSpeed) return null;
    var c = S.trechos.slice(0, 2).map(function (t) { return nearestAligned(v, t.linhas || []); });
    if (c[0] && c[1]) {
      // dois trajetos sobrepostos e no mesmo sentido: a geometria não decide
      if (Math.abs(c[0].dist - c[1].dist) < GEO.tie && Math.abs(c[0].ang - c[1].ang) < 30) return null;
      return (c[0].dist + c[0].ang * 0.5) <= (c[1].dist + c[1].ang * 0.5) ? 0 : 1;
    }
    return c[0] ? 0 : c[1] ? 1 : null;
  }

  function assignDirections(list) {
    var agree = 0, differ = 0;
    list.forEach(function (v) {
      v.geo = geoDir(v);
      if (v.geo != null && (v.directionId === 0 || v.directionId === 1)) {
        if (v.geo === v.directionId) agree++; else differ++;
      }
    });
    // se na maioria dos carros em movimento o feed contradiz a geometria, a ordem dos trajetos
    // está invertida nesta linha: o direction_id dos carros parados também é invertido
    var flip = differ >= 2 && differ > agree;
    S.dirStats = { agree: agree, differ: differ, flip: flip };
    list.forEach(function (v) {
      var feedDir = (v.directionId === 0 || v.directionId === 1) ? (flip ? 1 - v.directionId : v.directionId) : null;
      v.dir = v.geo != null ? v.geo : feedDir;
    });
  }
  
  
  //function dirIdx(v) { return v.directionId === 0 || v.directionId === 1 ? v.directionId : 'x'; }
  function dirIdx(v) { return v.dir === 0 || v.dir === 1 ? v.dir : 'x'; }
  function refTime() { return S.feed && S.feed.timestamp ? S.feed.timestamp : Date.now() / 1000; }
  function vehAge(v) { return v.timestamp ? Math.max(0, refTime() - v.timestamp) : null; }
  function vehStatus(v) {
    var age = vehAge(v);
    if (age != null && age > CONFIG.staleSec) return 'stale';
    return (v.speedKmh || 0) > 0 ? 'moving' : 'stopped';
  }
  function visibleVehicles() {
    return S.vehicles.filter(function (v) { var d = dirIdx(v); return d === 'x' || !S.hidden[d]; });
  }
  //function destinoDe(v) {
  //  var t = S.trechos[v.directionId];
  // return t && t.destino ? t.destino : null;
  //}
  function destinoDe(v) {
    var d = dirIdx(v), t = d === 'x' ? null : S.trechos[d];
    return t && t.destino ? t.destino : null;
  }

  function busSvg(status, bearing, cls) {
    var rot = bearing == null ? 0 : Math.round(bearing);
    return '<svg class="' + (cls || '') + '" viewBox="0 0 28 28" aria-hidden="true" style="transform:rotate(' + rot + 'deg)">' +
      '<circle class="disc" cx="14" cy="14" r="' + (status === 'stopped' ? 7 : 10) + '"/>' +
      '<path class="chev" d="M14 6.5 L19.2 16.5 L14 13.8 L8.8 16.5 Z"/></svg>';
  }

  function popupHtml(v) {
    var st = vehStatus(v), age = vehAge(v), dest = destinoDe(v);
    var l2 = dest ? 'Sentido ' + esc(dest) : 'Sentido não informado';
    var l3 = st === 'stale'
      ? 'Sem sinal há ' + fmtAge(age)
      : (v.speedKmh == null ? 'Velocidade não informada' : Math.round(v.speedKmh) + ' km/h');
    var l4 = st !== 'stale' && age != null ? 'Posição de ' + fmtAge(age) + ' atrás' : '';
    return '<div class="pop"><b>' + esc(v.id) + '</b><span>' + l2 + '</span><span>' + l3 + '</span>' +
      (l4 ? '<span>' + l4 + '</span>' : '') + '</div>';
  }

  function makeMarker(v) {
    var icon = L.divIcon({ className: 'bus', html: '', iconSize: [30, 30], iconAnchor: [15, 15] });
    var m = L.marker([v.lat, v.lon], { icon: icon, keyboard: false, riseOnHover: true });
    m.bindPopup(function () { return popupHtml(m._veh); }, { closeButton: false, offset: [0, -6] });
    return m;
  }

  function styleMarker(m, v) {
    var el = m.getElement();
    if (!el) return;
    var st = vehStatus(v);
    Array.prototype.slice.call(el.classList).forEach(function (c) {
      if (/^(is|dir)-/.test(c)) el.classList.remove(c);
    });
    el.classList.add('is-' + st, 'dir-' + dirIdx(v));
    el.innerHTML = busSvg(st, v.bearing);
    m.setZIndexOffset(st === 'moving' ? 200 : st === 'stopped' ? 100 : 0);
  }

  function glide(m, to) {
    var from = m.getLatLng();
    if (Math.abs(from.lat - to[0]) < 1e-7 && Math.abs(from.lng - to[1]) < 1e-7) return;
    if (m._raf) cancelAnimationFrame(m._raf);
    if (reduceMotion) { m.setLatLng(to); return; }
    var t0 = performance.now(), D = 1400, dl = to[0] - from.lat, dn = to[1] - from.lng;
    (function step(t) {
      var k = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - k, 3);
      m.setLatLng([from.lat + dl * e, from.lng + dn * e]);
      m._raf = k < 1 ? requestAnimationFrame(step) : 0;
    })(t0);
  }

  function clearMarkers() {
    markers.forEach(function (m) { if (m._raf) cancelAnimationFrame(m._raf); });
    busLayer.clearLayers();
    markers.clear();
  }

  function syncMarkers() {
    var seen = new Set();
    visibleVehicles().forEach(function (v) {
      var key = v.id || v.tripId;
      seen.add(key);
      var m = markers.get(key);
      if (!m) {
        m = makeMarker(v);
        m._veh = v;
        markers.set(key, m);
        busLayer.addLayer(m);
      } else {
        m._veh = v;
        glide(m, [v.lat, v.lon]);
        if (m.isPopupOpen()) m.getPopup().setContent(popupHtml(v));
      }
      styleMarker(m, v);
    });
    markers.forEach(function (m, key) {
      if (!seen.has(key)) {
        if (m._raf) cancelAnimationFrame(m._raf);
        busLayer.removeLayer(m);
        markers.delete(key);
      }
    });
  }

  function focusVehicle(id) {
    var m = markers.get(id);
    if (!m) return;
    var desktop = desktopMQ.matches;
    if (!desktop) setSnap('peek');
    var z = Math.max(map.getZoom(), 15), pt = map.project(m.getLatLng(), z);
    if (desktop) pt.x -= 206; else pt.y += (S.vis - 76) / 2;
    map.setView(map.unproject(pt, z), z, { animate: !reduceMotion });
    m.openPopup();
  }

  /* ----------------------------------------------------------------- painel */
  var SNAPS = ['peek', 'half', 'full'];
  function peekVis() { return els.body.offsetTop || 200; }
  function visFor(snap) {
    var vh = window.innerHeight, full = Math.round(vh * 0.9), peek = Math.min(peekVis(), full);
    if (snap === 'peek') return peek;
    if (snap === 'half') return Math.min(full, Math.max(peek + 120, Math.round(vh * 0.55)));
    return full;
  }
  function setVis(px) {
    S.vis = px;
    document.documentElement.style.setProperty('--vis', px + 'px');
  }
  var reframeTimer = null;
  function setSnap(snap, reframe) {
    S.snap = snap;
    els.sheet.dataset.snap = snap;
    setVis(visFor(snap));
    if (reframe && S.linha && !desktopMQ.matches) {
      clearTimeout(reframeTimer);
      reframeTimer = setTimeout(fitLine, 340); // depois da animação do painel
    }
  }
  var fitPending = false;
  function scheduleFit() {
    if (fitPending) return;
    fitPending = true;
    requestAnimationFrame(function () { fitPending = false; setSnap(S.snap); });
  }
  function cycleSnap() { setSnap(SNAPS[(SNAPS.indexOf(S.snap) + 1) % SNAPS.length], true); }

  function initSheet() {
    var drag = null;
    els.drag.addEventListener('pointerdown', function (e) {
      if (desktopMQ.matches || e.target.closest('.chip')) return;
      drag = { y0: e.clientY, vis0: S.vis, t0: performance.now(), moved: false };
      try { els.drag.setPointerCapture(e.pointerId); } catch (err) { /* ignora */ }
      els.sheet.classList.add('dragging');
    });
    els.drag.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dy = drag.y0 - e.clientY;
      if (Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) setVis(clamp(drag.vis0 + dy, visFor('peek'), visFor('full')));
    });
    function end(e) {
      if (!drag) return;
      var d = drag;
      drag = null;
      els.sheet.classList.remove('dragging');
      if (!d.moved) { cycleSnap(); return; }
      var dy = d.y0 - e.clientY, v = dy / Math.max(1, performance.now() - d.t0);
      var idx = SNAPS.indexOf(S.snap), target;
      if (Math.abs(v) > 0.4) {
        target = SNAPS[clamp(idx + (v > 0 ? 1 : -1), 0, SNAPS.length - 1)];
      } else {
        target = SNAPS.slice().sort(function (a, b) { return Math.abs(visFor(a) - S.vis) - Math.abs(visFor(b) - S.vis); })[0];
      }
      setSnap(target, true);
    }
    els.drag.addEventListener('pointerup', end);
    els.drag.addEventListener('pointercancel', end);
    els.grip.addEventListener('keydown', function (e) {
      var idx = SNAPS.indexOf(S.snap);
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycleSnap(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSnap(SNAPS[Math.min(idx + 1, 2)], true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSnap(SNAPS[Math.max(idx - 1, 0)], true); }
    });
    window.addEventListener('resize', scheduleFit);
  }

  /* -------------------------------------------------------------- renderização */
  /* letreiro: número da linha e destino em pontos luminosos */
  function ledWords(text, base, step) {
    var i = base - 1;
    return String(text).split(' ').filter(Boolean).map(function (w) {
      return '<span class="w">' + w.split('').map(function (c) {
        i++;
        return '<span aria-hidden="true" style="--d:' + (i * step) + 'ms">' + esc(c) + '</span>';
      }).join('') + '</span>';
    }).join(' ');
  }
  function destList() {
    var out = [];
    S.trechos.slice(0, 2).forEach(function (t, i) { if (t.destino && !S.hidden[i]) out.push(t.destino); });
    return out;
  }
  function paintDest() {
    var el = els.sign.querySelector('.sign-dest');
    if (!el || !S.linha) return;
    var list = destList();
    var txt = list.length ? list[S.signIdx % list.length] : '';
    el.hidden = !txt;
    el.dataset.size = txt.length <= 8 ? 's' : txt.length <= 14 ? 'm' : 'l';
    el.innerHTML = ledWords(txt, 0, 40);
  }
  function tickSign() {
    if (!S.linha || document.hidden || reduceMotion || destList().length < 2) return;
    S.signIdx++;
    paintDest();
  }
  function renderSign() {
    var empty = !S.linha;
    var num = empty ? '---' : S.linha.toUpperCase();
    var n = num.replace(/\s/g, '').length;
    var ds = destList();
    var label = empty ? 'Nenhuma linha escolhida' : 'Linha ' + S.linha + (ds.length ? ', sentido ' + ds.join(' e ') : '');
    els.sign.innerHTML = '<div class="sign-plate' + (empty ? ' off' : '') + '" role="img" aria-label="' + esc(label) + '">' +
      '<span class="sign-num" data-size="' + (n <= 3 ? 's' : n <= 5 ? 'm' : 'l') + '" aria-hidden="true">' + ledWords(num, 0, empty ? 0 : 110) + '</span>' +
      '<span class="sign-dest" aria-hidden="true"></span></div>';
    if (empty) {
      var d = els.sign.querySelector('.sign-dest');
      d.dataset.size = 'm';
      d.innerHTML = ledWords('ESCOLHA A LINHA', 3, 45);
    } else {
      paintDest();
    }
  }

  function renderChips() {
    if (!S.linha) { els.routes.hidden = true; els.routes.innerHTML = ''; return; }
    els.routes.hidden = false;
    var c = { 0: 0, 1: 0 };
    S.vehicles.forEach(function (v) { var d = dirIdx(v); if (d === 0 || d === 1) c[d]++; });;
    els.routes.innerHTML = S.trechos.slice(0, 2).map(function (t, i) {
      var n = c[i], nome = t.destino || ('Sentido ' + (i + 1));
      return '<button class="chip dir-' + i + '" type="button" data-dir="' + i + '" aria-pressed="' + (!S.hidden[i]) + '"' +
        (S.feed ? ' aria-label="' + esc(nome) + ', ' + n + (n === 1 ? ' carro' : ' carros') + '"' : '') + '>' +
        '<i class="dot"></i><span class="chip-t">' + esc(nome) + '</span>' +
        '<span class="chip-s">' + (S.feed ? n : '') + '</span></button>';
    }).join('');
  }

  var ERRORS = {
    net: {
      short: 'Sem acesso ao feed.',
      title: 'Não foi possível acessar o feed',
      text: 'O navegador não conseguiu falar com o serviço da Prefeitura. Pode ser falta de internet, uma falha temporária ou o bloqueio de acesso entre sites (CORS). Se o problema continuar com a internet funcionando, veja a seção "CORS" do README.'
    },
    timeout: {
      short: 'O feed demorou para responder.',
      title: 'O feed demorou demais para responder',
      text: 'O serviço não respondeu a tempo. O app tenta de novo sozinho.'
    },
    decode: {
      short: 'O feed veio em formato inesperado.',
      title: 'O feed veio em formato inesperado',
      text: 'A resposta não é um arquivo GTFS-Realtime válido. O endereço do serviço pode ter mudado.'
    }
  };
  function errorInfo(err) {
    if (err.kind === 'http') {
      return {
        short: 'O feed respondeu com erro ' + err.status + '.',
        title: 'O feed respondeu com erro ' + err.status,
        text: 'Costuma ser temporário, e o app tenta de novo sozinho. Se continuar por vários minutos, o endereço do serviço pode ter mudado.'
      };
    }
    return ERRORS[err.kind] || ERRORS.net;
  }

  function renderStatus() {
    var el = els.status;
    el.className = 'status';
    if (S.error) {
      el.hidden = false;
      el.classList.add('err');
      el.innerHTML = '<span>' + esc(errorInfo(S.error).short) + '</span><button class="link" type="button" data-act="retry">Tentar de novo</button>';
    } else if (!S.linha) {
      el.hidden = true;
      el.innerHTML = '';
    } else if (!S.lastOk) {
      el.hidden = false;
      el.textContent = 'Carregando posições…';
    } else {
      el.hidden = false;
      var old = S.feed && S.feed.timestamp && (Date.now() / 1000 - S.feed.timestamp) > CONFIG.feedOldSec;
      if (old) {
        el.classList.add('err');
        el.textContent = 'O feed está parado desde as ' + fmtClock(S.feed.timestamp * 1000) + '.';
      } else if (!S.vehicles.length) {
        el.textContent = 'Nenhum carro da linha aparece no feed agora.';
      } else {
        var c = { moving: 0, stopped: 0, stale: 0 };
        visibleVehicles().forEach(function (v) { c[vehStatus(v)]++; });
        var parts = [c.moving + ' em movimento', c.stopped + (c.stopped === 1 ? ' parado' : ' parados')];
        if (c.stale) parts.push(c.stale + ' sem sinal');
        el.innerHTML = '<b>' + parts.join(', ') + '</b><small>Atualizado às ' + fmtClock(S.lastOk) + '</small>';
      }
    }
    scheduleFit();
  }

  function noticeHtml(title, text, err) {
    return '<p class="notice' + (err ? ' err' : '') + '"><b>' + esc(title) + '</b>' + esc(text) + '</p>';
  }

  function legendHtml() {
    return '<ul class="legend">' +
      '<li>' + busSvg('moving', 45, 'glyph is-moving') + '<span>Em movimento. A seta aponta para onde o carro está indo.</span></li>' +
      '<li>' + busSvg('stopped', 0, 'glyph is-stopped') + '<span>Parado.</span></li>' +
      '<li>' + busSvg('stale', 0, 'glyph is-stale') + '<span>Sem sinal há mais de ' + Math.round(CONFIG.staleSec / 60) + ' minutos.</span></li></ul>';
  }

  function renderEmpty() {
    els.panelEmpty.innerHTML =
      '<h2>Onde está o seu ônibus?</h2>' +
      '<p>Busque pelo número da linha. O mapa mostra cada carro em tempo real, e você vê quanto tempo a viagem costuma levar em cada horário.</p>' +
      legendHtml() +
      '<p class="credits">Posições: feed GTFS-Realtime da SMTR, Prefeitura da Cidade do Rio de Janeiro. Atualizadas a cada ' + Math.round(CONFIG.refreshMs / 1000) + ' segundos enquanto uma linha está aberta.</p>';
  }

  function renderNow() {
    if (!S.linha) return;
    var out = [];
    var total = S.feed ? S.feed.vehicles.length : 0;
    if (S.error) {
      var info = errorInfo(S.error);
      out.push(noticeHtml(info.title, info.text, true));
    }
    var km = S.trechos.slice(0, 2).filter(function (t) { return t.extensao_m; }).map(function (t) {
      return fmtKm(t.extensao_m) + (t.destino ? ' até ' + esc(t.destino) : '');
    });
    if (km.length) out.push('<p class="fine">Trajeto de ' + km.join(' e ') + '.</p>');
    if (S.feed && !S.vehicles.length) {
      out.push(noticeHtml('Nenhum carro da linha ' + S.linha + ' no feed agora',
        total ? 'A linha pode estar fora de operação neste horário. O feed traz ' + total.toLocaleString('pt-BR') + ' veículos no total.' : 'O feed está vazio no momento.'));
    } else if (S.vehicles.length) {
      var order = { moving: 0, stopped: 1, stale: 2 };
      var list = visibleVehicles().slice().sort(function (a, b) {
        return order[vehStatus(a)] - order[vehStatus(b)] || String(a.id).localeCompare(String(b.id), 'pt-BR', { numeric: true });
      });
      out.push('<ul class="veh-list">' + list.map(function (v) {
        var st = vehStatus(v), age = vehAge(v), dest = destinoDe(v);
        var meta = st === 'stale' ? 'sem sinal' : (v.speedKmh == null ? '' : Math.round(v.speedKmh) + ' km/h');
        return '<li><button class="veh" type="button" data-id="' + esc(v.id || v.tripId) + '">' +
          busSvg(st, v.bearing, 'glyph is-' + st + ' dir-' + dirIdx(v)) +
          '<span class="veh-main"><b>' + esc(v.id) + '</b><span>' + (dest ? 'Sentido ' + esc(dest) : 'Sentido não informado') + '</span></span>' +
          '<span class="veh-meta">' + esc(meta) + (age != null ? '<small>há ' + fmtAge(age) + '</small>' : '') + '</span></button></li>';
      }).join('') + '</ul>');
      out.push(legendHtml());
    } else if (!S.error) {
      out.push('<p class="fine">Carregando posições…</p>');
    }

    if (S.feed) {
      var samples = GTFS.sampleRouteIds(S.feed.vehicles, 12);
      out.push('<details class="diag"' + (S.feed && !S.vehicles.length && total ? ' open' : '') + '><summary>Diagnóstico do feed</summary>' +
        '<p>Veículos no feed: <code>' + total + '</code>. Da linha ' + esc(S.linha) + ': <code>' + S.vehicles.length + '</code>.<br>' +
        (S.feed.timestamp ? 'Hora do feed: <code>' + fmtClock(S.feed.timestamp * 1000) + '</code>.<br>' : '') +
        'Exemplos de route_id: <code>' + (samples.length ? esc(samples.join(', ')) : 'nenhum') + '</code></p>' +
        (!S.vehicles.length && total ? '<p>Se a linha deveria aparecer, o route_id pode usar outro padrão de nome. Veja a seção "route_id" do README.</p>' : '') +
        '<p>Endereço: <code>' + esc(CONFIG.feedUrl) + '</code></p></details>');
    }
    out.push('<p class="credits">Posições: SMTR, Prefeitura da Cidade do Rio de Janeiro. Mapa: &copy; OpenStreetMap.</p>');
    els.panelNow.innerHTML = out.join('');
  }

  /* --------------------------------------------------- aba "Tempo de viagem" */
  function chartSvg(horas, dir, topMin, step) {
    var W = 360, H = 200, ml = 42, mr = 6, mt = 8, mb = 22;
    var iw = W - ml - mr, ih = H - mt - mb, cw = iw / 24, bw = cw * 0.64;
    function y(min) { return mt + ih * (1 - min / topMin); }
    var s = '<svg class="chart dir-' + dir + '" viewBox="0 0 ' + W + ' ' + H + '" role="group" aria-label="Tempo de viagem por hora de partida">';
    for (var m = 0; m <= topMin + 0.01; m += step) {
      s += '<line class="grid" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + y(m).toFixed(1) + '" y2="' + y(m).toFixed(1) + '"/>' +
        '<text x="' + (ml - 6) + '" y="' + (y(m) + 3.5).toFixed(1) + '" text-anchor="end">' + fmtTick(m) + (m === topMin && m < 60 ? ' min' : '') + '</text>';
    }
    for (var i = 0; i < 24; i++) {
      var b = horas && horas[i], x = ml + i * cw;
      var label = i + 'h às ' + (i + 1) + 'h: ' + (b ? 'entre ' + fmtDur(b[0]) + ' e ' + fmtDur(b[1]) : 'sem viagens');
      s += '<g class="col' + (i === S.hora ? ' sel' : '') + '" data-h="' + i + '" tabindex="0" role="button" aria-label="' + esc(label) + '">' +
        '<rect class="hit" x="' + x.toFixed(1) + '" y="' + mt + '" width="' + cw.toFixed(1) + '" height="' + ih + '"/>';
      if (b) {
        var yt = y(b[1]), yb = y(b[0]), h = Math.max(3, yb - yt);
        s += '<rect class="bar" x="' + (x + (cw - bw) / 2).toFixed(1) + '" y="' + yt.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2"/>';
      }
      s += '</g>';
      if (i % 3 === 0) s += '<text x="' + (x + cw / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + i + 'h</text>';
    }
    return s + '</svg>';
  }

  function readoutHtml(horas, h) {
    var b = horas && horas[h];
    var faixa = h + 'h às ' + (h + 1) + 'h' + (h === currentHour() ? ', horário atual' : '');
    if (!b) return 'Sem viagens nesse horário<small>' + faixa + '</small>';
    var a = fmtDur(b[0]), z = fmtDur(b[1]);
      return (a === z ? 'Cerca de ' + a : 'Entre ' + a + ' e ' + z) +
      '<small>' + faixa + '. ' + b[2].toLocaleString('pt-BR') + ' viagens.</small>';
  }

  function renderTrip() {
    var root = els.panelTrip;
    if (!S.linha) { root.innerHTML = ''; return; }
    if (!S.viagens) {
      root.innerHTML = noticeHtml('Histórico indisponível', 'O arquivo viagens.json não foi carregado. Gere-o com preprocessar.py e publique junto com o site.');
      return;
    }
    var dados = S.viagens.linhas[S.linha];
    if (!dados) {
      root.innerHTML = noticeHtml('Sem histórico para a linha ' + S.linha, 'Não há viagens dessa linha no período coberto pelo histórico.');
      return;
    }
    var tipos = Object.keys(dados);
    if (tipos.indexOf(S.tipoDia) < 0) S.tipoDia = pickTipoDia(tipos);
    if (S.hora == null) S.hora = currentHour();
    var dd = dados[S.tipoDia] || {}, keys = ['I', 'V'];

    var max = 0;
    keys.forEach(function (k) { (dd[k] || []).forEach(function (b) { if (b && b[1] > max) max = b[1]; }); });
    var maxMin = max, steps = [5, 10, 15, 20, 30, 60, 120, 240];
    var step = steps.filter(function (s) { return maxMin / s <= 5; })[0] || 240;
    var topMin = Math.max(step, Math.ceil(maxMin / step) * step);

    var horas = dd[keys[S.sentido]] || [];
    var meta = S.viagens.meta || {};
    root.innerHTML =
      '<h2>Quanto tempo leva</h2>' +
      '<div class="seg" role="group" aria-label="Tipo de dia">' + tipos.map(function (t) {
        return '<button type="button" data-tipo="' + esc(t) + '" aria-pressed="' + (t === S.tipoDia) + '"><span>' + esc(t) + '</span></button>';
      }).join('') + '</div>' +
      '<div class="seg" role="group" aria-label="Sentido">' + S.trechos.slice(0, 2).map(function (t, i) {
        return '<button type="button" class="dir-' + i + '" data-sent="' + i + '" aria-pressed="' + (i === S.sentido) + '"><i class="dot"></i><span>' + esc(t.destino || ('Sentido ' + (i + 1))) + '</span></button>';
      }).join('') + '</div>' +
      chartSvg(horas, S.sentido, topMin, step) +
      '<p class="readout" id="readout" aria-live="polite">' + readoutHtml(horas, S.hora) + '</p>' +
      '<p class="fine">Cada barra mostra o intervalo em que ficam metade das viagens que partiram naquela hora, do primeiro ao terceiro quartil.' +
      (meta.inicio ? ' Histórico de ' + fmtDate(meta.inicio) + ' a ' + fmtDate(meta.fim) + ', com ' + Number(meta.viagens).toLocaleString('pt-BR') + ' viagens.' : '') + '</p>';
  }

  function selectHour(h) {
    S.hora = h;
    var cols = els.panelTrip.querySelectorAll('.col');
    Array.prototype.forEach.call(cols, function (c) { c.classList.toggle('sel', parseInt(c.dataset.h, 10) === h); });
    var dd = (S.viagens.linhas[S.linha] || {})[S.tipoDia] || {};
    $('readout').innerHTML = readoutHtml(dd[['I', 'V'][S.sentido]], h);
  }

  /* -------------------------------------------------------------------- abas */
  function setTab(name, quiet) {
    S.tab = name;
    var now = name === 'now';
    els.tabNow.setAttribute('aria-selected', now);
    els.tabTrip.setAttribute('aria-selected', !now);
    els.panelNow.hidden = !(S.linha && now);
    els.panelTrip.hidden = !(S.linha && !now);
    els.panelEmpty.hidden = !!S.linha;
    els.tabs.hidden = !S.linha;
    if (!quiet && S.linha && !desktopMQ.matches) setSnap(now ? 'half' : 'full', true);
    els.body.scrollTop = 0;
    scheduleFit();
  }

  function renderAll() {
    renderSign();
    renderChips();
    renderStatus();
    renderEmpty();
    renderNow();
    renderTrip();
    setTab(S.tab, true);
  }

  /* -------------------------------------------------------------- feed ao vivo */
  function classify(err) {
    if (err && err.kind) return err;
    if (err && err.name === 'AbortError') return { kind: 'timeout', message: String(err) };
    return { kind: 'net', message: String(err) };
  }

  function matchLine() {
    var byId = new Map();
    GTFS.filterLine(S.feed.vehicles, S.linha).forEach(function (v) {
      var k = v.id || v.tripId, o = byId.get(k);
      if (!o || (v.timestamp || 0) > (o.timestamp || 0)) byId.set(k, v);
    });
    return Array.from(byId.values());
  }

  function applyFeed() {
    if (!S.feed || !S.linha) return;
    S.vehicles = matchLine();
    assignDirections(S.vehicles);
    syncMarkers();
    renderChips();
    renderStatus();
    renderNow();
  }

  function schedule() {
    clearTimeout(S.timer);
    els.progress.classList.remove('run');
    if (!S.linha || document.hidden) return;
    els.progress.style.setProperty('--refresh', CONFIG.refreshMs + 'ms');
    void els.progress.offsetWidth;
    els.progress.classList.add('run');
    S.timer = setTimeout(refresh, CONFIG.refreshMs);
  }

  function refresh() {
    if (S.fetching || !S.linha) return;
    S.fetching = true;
    clearTimeout(S.timer);
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, CONFIG.fetchTimeoutMs);
    fetch(CONFIG.feedUrl, { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) {
        if (!r.ok) { var e = new Error('HTTP ' + r.status); e.kind = 'http'; e.status = r.status; throw e; }
        return r.arrayBuffer();
      })
      .then(function (buf) {
        try { S.feed = GTFS.decodeFeed(buf); }
        catch (err) { var e = new Error(String(err && err.message || err)); e.kind = 'decode'; throw e; }
        S.lastOk = Date.now();
        S.error = null;
        applyFeed();
      })
      .catch(function (err) {
        S.error = classify(err);
        renderStatus();
        renderNow();
      })
      .then(function () {
        clearTimeout(to);
        S.fetching = false;
        schedule();
      });
  }

  /* ------------------------------------------------------------ escolha da linha */
  function selectLinha(input) {
    var key = S.keyIndex[squash(input)];
    if (!key) { toast('Não encontramos a linha ' + input + '. Confira o número e tente de novo.'); return false; }
    S.linha = key;
    S.trechos = S.itins[key].trechos || [];
    S.hidden = { 0: false, 1: false };
    S.vehicles = [];
    S.tipoDia = null; S.hora = null; S.sentido = 0;
    S.error = null;
    S.signIdx = 0;
    els.q.value = key;
    document.title = 'Linha ' + key + ' - Ônibus do Rio ao vivo';
    try { history.replaceState(null, '', '#' + encodeURIComponent(key)); } catch (e) { /* ignora */ }

    clearMarkers();
    drawRoute();
    renderAll();
    setTab('now', true);
    fitLine();
    if (S.feed) applyFeed();
    if (!S.lastOk || Date.now() - S.lastOk > 5000) refresh(); else schedule();
    return true;
  }

  /* ----------------------------------------------------------------------- busca */
  var sug = { list: [], idx: -1 };

  function matchKeys(q) {
    var Q = squash(q);
    if (!Q) return S.keys.slice(0, 400);
    var starts = [], inc = [];
    S.keys.forEach(function (k) {
      var K = squash(k);
      if (K.indexOf(Q) === 0) starts.push(k); else if (K.indexOf(Q) > 0) inc.push(k);
    });
    return starts.concat(inc).slice(0, 80);
  }
  function destinosDe(k) {
    return (S.itins[k].trechos || []).map(function (t) { return t.destino; }).filter(Boolean).join(' / ');
  }
  function showSuggest() {
    if (!S.itins) return;
    sug.list = matchKeys(els.q.value);
    sug.idx = -1;
    els.suggest.innerHTML = sug.list.length
      ? sug.list.map(function (k, i) {
          return '<li role="option" id="opt-' + i + '" data-l="' + esc(k) + '"><b>' + esc(k) + '</b><span>' + esc(destinosDe(k)) + '</span></li>';
        }).join('')
      : '<li class="none">Nenhuma linha com esse número.</li>';
    els.suggest.hidden = false;
    els.q.setAttribute('aria-expanded', 'true');
  }
  function hideSuggest() {
    els.suggest.hidden = true;
    els.q.setAttribute('aria-expanded', 'false');
    els.q.removeAttribute('aria-activedescendant');
  }
  function moveSuggest(d) {
    if (els.suggest.hidden) showSuggest();
    if (!sug.list.length) return;
    sug.idx = (sug.idx + d + sug.list.length) % sug.list.length;
    Array.prototype.forEach.call(els.suggest.children, function (li, i) { li.setAttribute('aria-selected', i === sug.idx); });
    var cur = els.suggest.children[sug.idx];
    els.q.setAttribute('aria-activedescendant', cur.id);
    cur.scrollIntoView({ block: 'nearest' });
  }

  function initSearch() {
    els.q.addEventListener('focus', function () { els.q.select(); showSuggest(); });
    els.q.addEventListener('input', showSuggest);
    els.q.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggest(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggest(-1); }
      else if (e.key === 'Escape') { hideSuggest(); els.q.blur(); }
    });
    els.form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!S.itins) return;
      var typed = els.q.value.trim();
      var pick = sug.idx >= 0 ? sug.list[sug.idx] : (S.keyIndex[squash(typed)] || (sug.list.length === 1 ? sug.list[0] : null));
      if (!typed && !pick) return;
      if (pick) { hideSuggest(); els.q.blur(); selectLinha(pick); }
      else toast('Não encontramos a linha ' + typed + '. Confira o número e tente de novo.');
    });
    // pointerdown (e não click) para o campo não perder o foco antes da escolha
    els.suggest.addEventListener('pointerdown', function (e) {
      var li = e.target.closest('li[data-l]');
      if (!li) return;
      e.preventDefault();
      hideSuggest();
      els.q.blur();
      selectLinha(li.dataset.l);
    });
    document.addEventListener('pointerdown', function (e) {
      if (!e.target.closest('.search-wrap')) hideSuggest();
    });
  }

  /* ---------------------------------------------------------------- eventos */
  function initEvents() {
    els.theme.addEventListener('click', function () { applyTheme(S.theme === 'dark' ? 'light' : 'dark', true); });
    els.tabNow.addEventListener('click', function () { setTab('now'); });
    els.tabTrip.addEventListener('click', function () { setTab('trip'); });

    els.routes.addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      var d = parseInt(b.dataset.dir, 10);
      S.hidden[d] = !S.hidden[d];
      if (S.hidden[0] && S.hidden[1]) S.hidden[1 - d] = false; // sempre sobra um sentido visível
      S.signIdx = 0;
      renderChips();
      paintDest();
      syncRouteVisibility();
      syncMarkers();
      renderStatus();
      renderNow();
    });

    els.status.addEventListener('click', function (e) {
      if (e.target.closest('[data-act="retry"]')) refresh();
    });
    els.panelNow.addEventListener('click', function (e) {
      var b = e.target.closest('.veh');
      if (b) focusVehicle(b.dataset.id);
    });
    els.panelTrip.addEventListener('click', function (e) {
      var col = e.target.closest('.col'), tipo = e.target.closest('[data-tipo]'), sent = e.target.closest('[data-sent]');
      if (col) selectHour(parseInt(col.dataset.h, 10));
      else if (tipo) { S.tipoDia = tipo.dataset.tipo; renderTrip(); }
      else if (sent) { S.sentido = parseInt(sent.dataset.sent, 10); renderTrip(); }
    });
    els.panelTrip.addEventListener('keydown', function (e) {
      var col = e.target.closest('.col');
      if (col && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectHour(parseInt(col.dataset.h, 10)); }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { clearTimeout(S.timer); els.progress.classList.remove('run'); }
      else if (S.linha) {
        if (!S.lastOk || Date.now() - S.lastOk > CONFIG.refreshMs) refresh(); else schedule();
      }
    });
    window.addEventListener('online', function () { if (S.linha) refresh(); });
    window.addEventListener('hashchange', function () {
      var h = decodeURIComponent(location.hash.slice(1));
      if (h && squash(h) !== squash(S.linha || '')) selectLinha(h);
    });
  }

  /* ----------------------------------------------------------------- início */
  function loadJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
      return r.json();
    });
  }

  function fatal(title, text) {
    els.panelEmpty.innerHTML = noticeHtml(title, text, true);
    scheduleFit();
  }

  function init() {
    var saved = document.documentElement.getAttribute('data-theme');
    applyTheme(saved === 'dark' ? 'dark' : 'light', false);
    initSheet();
    initSearch();
    initEvents();
    renderAll();
    setSnap('peek');
    S.signTimer = setInterval(tickSign, 4500);

    try { GTFS.init(); }
    catch (e) { fatal('Não foi possível iniciar o leitor do feed', 'O arquivo protobuf.min.js não foi carregado. Confira se ele foi publicado junto com o site.'); return; }

    Promise.all([loadJson('itinerarios.json'), loadJson('viagens.json').catch(function () { return null; })])
      .then(function (res) {
        S.itins = res[0];
        S.viagens = res[1];
        S.keys = Object.keys(S.itins).sort(function (a, b) { return a.localeCompare(b, 'pt-BR', { numeric: true }); });
        S.keys.forEach(function (k) { S.keyIndex[squash(k)] = k; });
        var h = decodeURIComponent(location.hash.slice(1));
        if (h) selectLinha(h);
      })
      .catch(function (err) {
        fatal('Não foi possível carregar os trajetos',
          'O arquivo itinerarios.json não foi encontrado. Gere-o com preprocessar.py e publique junto com o site. ' +
          'Se você abriu o index.html direto do computador, use um servidor (por exemplo, python -m http.server) ou o GitHub Pages. (' + err.message + ')');
      });
  }

  init();
})();
