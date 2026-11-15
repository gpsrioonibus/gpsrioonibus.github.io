/*
 * Leitura do feed GTFS-Realtime (VehiclePositions) no navegador.
 * Depende do protobuf.js (protobuf.min.js), carregado antes deste arquivo.
 *
 * Só os campos usados pelo app estão declarados. Os demais campos do feed
 * são ignorados na decodificação (é assim que o protobuf funciona).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GTFS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PROTO = [
    'syntax = "proto2";',
    'package transit_realtime;',
    'message FeedMessage {',
    '  optional FeedHeader header = 1;',
    '  repeated FeedEntity entity = 2;',
    '}',
    'message FeedHeader {',
    '  optional string gtfs_realtime_version = 1;',
    '  optional uint64 timestamp = 3;',
    '}',
    'message FeedEntity {',
    '  optional string id = 1;',
    '  optional VehiclePosition vehicle = 4;',
    '}',
    'message VehiclePosition {',
    '  optional TripDescriptor trip = 1;',
    '  optional VehicleDescriptor vehicle = 8;',
    '  optional Position position = 2;',
    '  optional uint64 timestamp = 5;',
    '}',
    'message TripDescriptor {',
    '  optional string trip_id = 1;',
    '  optional string route_id = 5;',
    '  optional uint32 direction_id = 6;',
    '}',
    'message VehicleDescriptor {',
    '  optional string id = 1;',
    '  optional string label = 2;',
    '}',
    'message Position {',
    '  optional float latitude = 1;',
    '  optional float longitude = 2;',
    '  optional float bearing = 3;',
    '  optional float speed = 5;',
    '}'
  ].join('\n');

  var FeedMessage = null;

  /** Prepara o decodificador. Em Node, passe a biblioteca: GTFS.init(require('protobufjs')). */
  function init(pb) {
    pb = pb || (typeof protobuf !== 'undefined' ? protobuf : null);
    if (!pb) throw new Error('protobuf.js não foi carregado');
    var root = pb.parse(PROTO).root; // nomes em camelCase: routeId, directionId...
    FeedMessage = root.lookupType('transit_realtime.FeedMessage');
  }

  /**
   * Decodifica o corpo da resposta (ArrayBuffer ou Uint8Array).
   * Retorna { timestamp (segundos ou null), vehicles: [...] }.
   */
  function decodeFeed(buffer) {
    if (!FeedMessage) init();
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var msg = FeedMessage.decode(bytes);
    var obj = FeedMessage.toObject(msg, { longs: Number, defaults: false });

    var vehicles = [];
    (obj.entity || []).forEach(function (e) {
      var v = e.vehicle;
      if (!v || !v.position) return;
      var lat = v.position.latitude, lon = v.position.longitude;
      if (typeof lat !== 'number' || typeof lon !== 'number') return;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return;

      var trip = v.trip || {}, veh = v.vehicle || {};
      var speed = v.position.speed;
      vehicles.push({
        id: veh.id || veh.label || e.id || '',
        routeId: trip.routeId || '',
        tripId: trip.tripId || '',
        directionId: typeof trip.directionId === 'number' ? trip.directionId : null,
        lat: lat,
        lon: lon,
        bearing: typeof v.position.bearing === 'number' ? v.position.bearing : null,
        speedKmh: typeof speed === 'number' ? Math.round(speed * 3.6 * 10) / 10 : null, // m/s para km/h
        timestamp: typeof v.timestamp === 'number' ? v.timestamp : null
      });
    });

    return {
      timestamp: obj.header && typeof obj.header.timestamp === 'number' ? obj.header.timestamp : null,
      vehicles: vehicles
    };
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Diz se um route_id do feed corresponde ao número da linha.
   * O route_id nem sempre é igual ao número da linha (ex.: "O0422AAA" para a 422),
   * então o número é procurado como trecho inteiro, ignorando zeros à esquerda.
   * Se o feed usar outro padrão, é este o único ponto a ajustar.
   */
  function matchesLine(routeId, linha) {
    var l = String(linha == null ? '' : linha).replace(/\s+/g, '');
    var r = String(routeId == null ? '' : routeId).replace(/\s+/g, '');
    if (!l || !r) return false;
    if (r.toLowerCase() === l.toLowerCase()) return true;
    return new RegExp('(^|[^0-9])0*' + escapeRe(l) + '(?![0-9])', 'i').test(r);
  }

  function filterLine(vehicles, linha) {
    return vehicles.filter(function (v) { return matchesLine(v.routeId, linha); });
  }

  /** Exemplos de route_id distintos, para o painel de diagnóstico. */
  function sampleRouteIds(vehicles, n) {
    var seen = {}, out = [];
    for (var i = 0; i < vehicles.length && out.length < n; i++) {
      var r = vehicles[i].routeId;
      if (r && !seen[r]) { seen[r] = true; out.push(r); }
    }
    return out;
  }

  return {
    PROTO: PROTO,
    init: init,
    decodeFeed: decodeFeed,
    matchesLine: matchesLine,
    filterLine: filterLine,
    sampleRouteIds: sampleRouteIds
  };
});
