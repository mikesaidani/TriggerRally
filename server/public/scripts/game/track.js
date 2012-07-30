/**
 * @author jareiko / http://www.jareiko.net/
 */

define([
  'util/LFIB4',
  'THREE',
  'game/scenery',
  'game/terrain',
  'util/image',
  'cs!util/quiver',
  'util/util'
],
function(LFIB4, THREE, gameScenery, gameTerrain, uImg, quiver, util) {
  var exports = {};

  var Vec2 = THREE.Vector2;
  var Vec3 = THREE.Vector3;
  var catmullRom = util.catmullRom;

  exports.Track = function() {
    this.config = {};
    this.checkpoints = [];
  };

  exports.Track.prototype.loadWithConfig = function(config, callback) {
    this.config = config;

    if (config.terrain) {
      var terrainConfig = config.terrain;
      if (!config.terrain) {
        // Fallback for older configs.
        terrainConfig = {
          height: {
            url: config.terrain.heightmap,
            scale: [
              config.terrain.horizontalscale,
              config.terrain.horizontalscale,
              config.terrain.verticalscale
            ]
          }
        };
      }

      var source = new gameTerrain.ImageSource();
      var terrain = new gameTerrain.Terrain(source);
      this.terrain = terrain;

      source.load(terrainConfig, function() {
        var course = config.course;
        if (config.gameversion <= 1) course.coordscale[1] *= -1;

        var maps = this.terrain.source.maps;

        var drawTrack = function(ins, outs, callback) {
          var src = ins[0], dst = outs[0];
          var surf = outs[1];
          var checkpointsXY = ins[1];
          var checkpoints = outs[2];

          dst.width = src.width;
          dst.height = src.height;
          dst.data = new src.data.constructor(src.data);

          //uImg.ensureDims(surf, src.width, src.height, 4, Uint8Array);
          uImg.createBuffer(surf, src.width, src.height, 4, Uint8Array);

          checkpoints.length = 0;
          var numCheckpoints = checkpointsXY.length;
          for (var i = 0; i < numCheckpoints; ++i) {
            checkpoints.push(
                new Vec3(checkpointsXY[i].pos[0] * course.coordscale[0],
                         checkpointsXY[i].pos[1] * course.coordscale[1],
                         0));
          }
          quiver.push(checkpoints);

          var adjustCheckpointHeights = function() {
            checkpoints.forEach(function (cpWithZ) {
              var contact = this.terrain.getContact(cpWithZ);
              cpWithZ.z = contact.surfacePos.z;
            }, this);
          }.bind(this);
          adjustCheckpointHeights();

          // Cut course into terrain.
          // TODO: Move this to terrain module.
          function wrap(x, lim) { return x - Math.floor(x / lim) * lim; };
          function cubic(x) { return 3 * x*x - 2 * x*x*x; };
          function drawCircle(map, chan, x, y, value, radius, hardness, opacity) {
            var scaleX = map.scale.x, scaleY = map.scale.y;
            var img = map.data;
            var cx = map.width, cy = map.height;
            var numChan = img.length / cx / cy;
            var data = map.data;
            var mX = x / scaleX;
            var mY = y / scaleY;
            // The circle gets mapped to an ellipse in image space.
            var mRadX = radius / map.scale.x;
            var mRadY = radius / map.scale.y;
            var mMinX = Math.ceil(mX - mRadX), mMaxX = mX + mRadX;
            var mMinY = Math.ceil(mY - mRadY), mMaxY = mY + mRadY;
            var iX, iY, wX, wY, wR, i, weight;
            for (iY = mMinY; iY <= mMaxY; ++iY) {
              wY = iY * scaleY - y;
              wY *= wY;
              for (iX = mMinX; iX <= mMaxX; ++iX) {
                wX = iX * scaleX - x;
                wX *= wX;
                wR = Math.sqrt(wX + wY);
                if (wR < radius) {
                  wR /= radius;
                  if (wR <= hardness)
                    weight = 1;
                  else
                    weight = cubic((1 - wR) / (1 - hardness));
                  i = (wrap(iX, cx) + cx * wrap(iY, cy)) * numChan + chan;
                  data[i] += (value - data[i]) * weight * opacity;
                }
              }
            }
          };
          function drawCircleDisplacement(map, x, y, value, radius, hardness, opacity) {
            drawCircle(map, 0, x, y, value / map.scale.z, radius, hardness, opacity);
          }

          // Fill type
          (function() {
            for (var i = 2, l = surf.data.length; i < l; i += 4) {
              surf.data[i] = 255 * 0.1;
            }
          })();

          // Track curve.
          var pts = checkpoints;

          // First we compute the chord length of the curve.
          var totalLength = 0;
          var chords = [];
          var numChords = pts.length - 1;
          var i;
          for (i = 0; i < numChords; ++i) {
            var chordLength = new Vec2().sub(pts[i+1], pts[i]).length();
            chords.push(chordLength);
            totalLength += chordLength;
          }

          var radius = 120;
          var calls = [];
          var tStep = radius / 3;
          var t = 0;
          var halfX = surf.scale.x / 2;
          var halfY = surf.scale.y / 2;
          for (i = 0; i < numChords; ++i) {
            // TODO: try different start point positions?
            var cp = [ pts[i-1] || pts[i], pts[i], pts[i+1], pts[i+2] || pts[i+1] ];
            for (; t < chords[i]; t += tStep) {
              var u = t / chords[i];
              var pX = catmullRom(cp[0].x, cp[1].x, cp[2].x, cp[3].x, u);
              var pY = catmullRom(cp[0].y, cp[1].y, cp[2].y, cp[3].y, u);
              var pZ = catmullRom(cp[0].z, cp[1].z, cp[2].z, cp[3].z, u);

              drawCircleDisplacement(dst, pX, pY, pZ, radius, 0, 0.6);
              drawCircle(surf, 2, pX - halfX, pY - halfY, 255 * 0, radius * 0.5, 0.8, 1);
              //drawCircle(maps.surface, maps.surface.packed, 4, 2, pX, pY, 255, 100, 0.4, 1);
            }
            t -= chords[i];
          }
          // Stagger the drawCircle calls.
          /*var samples = [0, 2, 4, 1, 5, 3], jump = samples.length, j;
          for (j = 0; j < jump; ++j) {
            for (i = samples[j]; i < calls.length; i += jump) {
              calls[i]();
            }
          }*/
          adjustCheckpointHeights();
          callback();
        };

        var prepSurface = function(ins, outs, callback) {
          var src = ins[0], dst = outs[0];
          var srcData = src.data, srcChannels = uImg.channels(src);
          uImg.ensureDims(dst, src.width, src.height, srcChannels, Uint8Array);
          var dstData = dst.data, dstChannels = uImg.channels(dst);
          var minX = 0, minY = 0, maxX = src.width, maxY = src.height;
          var sX, sY, srcPtr, dstPtr, derivX, derivY, type, gradient, roughness;
          for (sY = minY; sY < maxY; ++sY) {
            srcPtr = (sY * src.width) * srcChannels;
            dstPtr = (sY * dst.width) * dstChannels;
            for (sX = minX; sX < maxX; ++sX) {
              derivX = srcData[srcPtr + 0] / 127.5 - 1;
              derivY = srcData[srcPtr + 1] / 127.5 - 1;
              type = srcData[srcPtr + 2];
              gradient = Math.sqrt(derivX * derivX + derivY * derivY);
              roughness = gradient * 0.1 * type + 0.02;
              dstData[dstPtr + 3] = Math.min(255, roughness * 256);
              srcPtr += srcChannels;
              dstPtr += dstChannels;
            }
          }
          callback();
        };

        // Move to quiver? insertBefore?
        var disconnect = function(srcNode, dstNode) {
          srcNode.outputs.splice(srcNode.outputs.indexOf(dstNode), 1);
          dstNode.outputs.splice(dstNode.inputs.indexOf(srcNode), 1);
        };

        (function() {
          var heightNode = maps.height._quiverNode;
          var sourceNode = heightNode.inputs[0];
          var drawTrackNode = new quiver.Node(drawTrack.bind(this));
          disconnect(sourceNode, heightNode);
          quiver.connect(sourceNode,
                         uImg.createBuffer(null, 1, 1, 1, Float32Array),
                         drawTrackNode,
                         heightNode);

          quiver.connect(drawTrackNode,
                         maps.surface);

          quiver.connect(this.config.course.checkpoints,
                         drawTrackNode,
                         this.checkpoints);
        }).call(this);

        (function() {
          var oldSurfaceNode = maps.surface._quiverNode;
          var newSurfaceNode = new quiver.Node(maps.surface);
          maps.surface._quiverNode = newSurfaceNode;
          quiver.connect(oldSurfaceNode,
                         prepSurface,
                         newSurfaceNode);
        }).call(this);

        //this.scenery = new gameScenery.Scenery(config.scenery, this);

        if (callback) callback();
      }.bind(this));
    }
  };

  return exports;
});