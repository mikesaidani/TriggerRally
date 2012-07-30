/**
 * @author jareiko / http://www.jareiko.net/
 */

define([
  'THREE',
  'async',
  'util/image',
  'cs!util/quiver',
  'util/util'
],
function(THREE, async, uImg, quiver, util) {
  var exports = {};

  var Vec2 = THREE.Vector2;
  var Vec3 = THREE.Vector3;
  var INTERP = util.INTERP;
  var catmullRom = util.catmullRom;
  var catmullRomDeriv = util.catmullRomDeriv;

  var inNode = false;
  if (typeof Image === 'undefined') {
    // Running in node.
    inNode = true;
    var Canvas = require('canvas');
  }

  function wrap(x, lim) { return x - Math.floor(x / lim) * lim; }

  exports.ImageSource = function() {
    this.maps = {};
  };

  exports.ImageSource.prototype.load = function(config, callback) {
    this.config = config;
    var maps = this.maps;

    for (var k in config) {
      if (config[k].url)
        config[k].url = new String(config[k].url);
      maps[k] = {
        scale: new Vec3(config[k].scale[0],
                        config[k].scale[1],
                        config[k].scale[2])
      };
    }
    if (!maps.surface) {
      maps.surface = {
        scale: maps.height.scale,
      };
    }
    // Create seed buffers. The pipeline will preserve their data types.
    uImg.createBuffer(maps.height, 1, 1, 1, Float32Array);
    //uImg.createBuffer(maps.surface, 1, 1, 4, Uint8Array);
    uImg.createBuffer(maps.detail, 1, 1, 4, Uint8Array);

    // Note to self: elevation data in 8-bit PNG seems to compress 20% better
    // if you split the channels into separate greyscale PNG images.
    // (on Engelberg 1024x1024 dataset).

    // TODO: More uniform handling of data types. Scale
    // everything to a 0-1 range?

    // Set up processing pipelines.
    // TODO: discard intermediate buffers.
    quiver.connect(
        config.height.url,
        uImg.imageFromUrl(),
        {},
        uImg.getImageData({flip: true}),
        {},
        uImg.unpack16bit(),
        maps.height,
        // We scale the derivatives to fit a Uint8 buffer.
        uImg.catmullRomDerivatives(127.5 / 127.5, 127.5),
        maps.surface);

    if (config.detail) {
      // TODO: omit copyChannel stage.
      quiver.connectParallel(
          config.detail.url,
          uImg.imageFromUrl(),
          {},
          uImg.getImageData({flip: true}),
          {},
          [ uImg.copyChannel(0, 2), uImg.derivatives(2, 127.5) ],
          maps.detail);
    }
    callback();
  };

  exports.Terrain = function(source) {
    this.source = source;
    // We don't really support tiles yet, just repeat a single tile.
    this.theTile = new exports.TerrainTile(this);
  };

  exports.Terrain.prototype.getContact = function(pt) {
    return this.getContactRayZ(pt.x, pt.y);
  }

  // x, y = terrain space coordinates
  exports.Terrain.prototype.getContactRayZ = function(x, y) {
    var contact = null;
    // We just repeat a single tile infinitely.
    var tile = this.theTile; //this.getTile(tx, ty);
    if (tile) {
      contact = tile.getContactRayZ(x, y);
    } else {
      // TODO: Fire off a request to load this tile.
    }
    return contact;
  };

  exports.TerrainTile = function(terrain) {
    this.terrain = terrain;
  };

  var sampleBilinear = function(map, channel, x, y, derivsOut) {
    var numChannels = uImg.channels(map);
    var dmap = new map.data.constructor(map.data.buffer, channel);
    var cx = map.width;
    var cy = map.height;
    var mx = x / map.scale.x;
    var my = y / map.scale.y;
    var floorx = Math.floor(mx);
    var floory = Math.floor(my);
    var h = [
      dmap[(wrap(floorx    , cx) + wrap(floory    , cy) * cx) * numChannels],
      dmap[(wrap(floorx + 1, cx) + wrap(floory    , cy) * cx) * numChannels],
      dmap[(wrap(floorx    , cx) + wrap(floory + 1, cy) * cx) * numChannels],
      dmap[(wrap(floorx + 1, cx) + wrap(floory + 1, cy) * cx) * numChannels]
    ]
    var fracx = mx - floorx;
    var fracy = my - floory;
    var sample = INTERP(
        INTERP(h[0], h[1], fracx),
        INTERP(h[2], h[3], fracx),
        fracy);
    if (derivsOut) {
      derivsOut.x = (h[1] + h[3] - h[0] - h[2]) * 0.5;
      derivsOut.y = (h[2] + h[3] - h[0] - h[1]) * 0.5;
    }
    return sample;
  };

  // lx, ly = local tile space coordinates
  exports.TerrainTile.prototype.getContactRayZ = function(x, y) {
    var mapHeight = this.terrain.source.maps.height;
    var mapDetail = this.terrain.source.maps.detail;
    var mapSurface = this.terrain.source.maps.surface;
    var tX = x / mapHeight.scale.x;
    var tY = y / mapHeight.scale.y;
    var floorx = Math.floor(tX);
    var floory = Math.floor(tY);
    var fracx = tX - floorx;
    var fracy = tY - floory;
    var cx = mapHeight.width;
    var cy = mapHeight.height;
    var hmap = mapHeight.data;

    if (!hmap) {
      // No data yet.
      return {
        normal: new Vec3(0, 0, 1),
        surfacePos: new Vec3(x, y, 0)
      }
    }

    // This assumes that the tile repeats in all directions.
    var h = [], i = 0, sx, sy;
    for (sy = -1; sy <= 2; ++sy) {
      for (sx = -1; sx <= 2; ++sx) {
        h[i++] = hmap[wrap(floorx + sx, cx) + wrap(floory + sy, cy) * cx];
      }
    }
    var height = catmullRom(
        catmullRom(h[ 0], h[ 1], h[ 2], h[ 3], fracx),
        catmullRom(h[ 4], h[ 5], h[ 6], h[ 7], fracx),
        catmullRom(h[ 8], h[ 9], h[10], h[11], fracx),
        catmullRom(h[12], h[13], h[14], h[15], fracx),
        fracy) * mapHeight.scale.z;

    // TODO: Optimize this!
    var derivX = catmullRomDeriv(
        catmullRom(h[ 0], h[ 4], h[ 8], h[12], fracy),
        catmullRom(h[ 1], h[ 5], h[ 9], h[13], fracy),
        catmullRom(h[ 2], h[ 6], h[10], h[14], fracy),
        catmullRom(h[ 3], h[ 7], h[11], h[15], fracy),
        fracx) * (mapHeight.scale.z / mapHeight.scale.x);
    var derivY = catmullRomDeriv(
        catmullRom(h[ 0], h[ 1], h[ 2], h[ 3], fracx),
        catmullRom(h[ 4], h[ 5], h[ 6], h[ 7], fracx),
        catmullRom(h[ 8], h[ 9], h[10], h[11], fracx),
        catmullRom(h[12], h[13], h[14], h[15], fracx),
        fracy) * (mapHeight.scale.z / mapHeight.scale.y);

    var detailAmount = 1;

    if (mapSurface && mapSurface.data) {
      detailAmount *= sampleBilinear(mapSurface, 3,
                                     x - 0.5 * mapSurface.scale.x,
                                     y - 0.5 * mapSurface.scale.y) / 255;
    }

    if (mapDetail && mapDetail.data) {
      detailAmount *= mapDetail.scale.z;
      var detailDeriv = new Vec2();
      height += sampleBilinear(mapDetail, 2, x, y, detailDeriv) * detailAmount;
      derivX += detailDeriv.x * detailAmount / mapDetail.scale.x;
      derivY += detailDeriv.y * detailAmount / mapDetail.scale.y;
    }

    var normal = new Vec3(-derivX, -derivY, 1).normalize();

    return {
      normal: normal,
      surfacePos: new Vec3(x, y, height)
    };
  };

  return exports;
});