/* Connecting state from thinking-orbs by Jakub Antalik (MIT).
   Same geometry as the library. Ink is the site accent. */
(function () {
  var canvas = document.querySelector("#stage-loading canvas.lg-loader");
  var stage = document.getElementById("stage-loading");
  if (!canvas || !stage || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var OPTS = {
    nodeN: 41,
    thr: 0.72,
    signals: 7,
    nodeR: 1.33,
    nodeRDepth: 1.71,
    lineW: 0.8,
    rsPow: 0.6,
    rMin: 0.3,
  };
  var SPEED = 3.315;
  var accent = [27, 125, 138];
  var dark = false;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var raf = 0;
  var started = 0;

  function hashD(a, b) {
    var h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return h - Math.floor(h);
  }

  function vnoise(x, y) {
    var xi = Math.floor(x);
    var yi = Math.floor(y);
    var fx = x - xi;
    var fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    var a = hashD(xi, yi);
    var b = hashD(xi + 1, yi);
    var c = hashD(xi, yi + 1);
    var d = hashD(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  function fibDir(i, n) {
    var golden = Math.PI * (3 - Math.sqrt(5));
    var y = 1 - (2 * (i + 0.5)) / n;
    var rad = Math.sqrt(1 - y * y);
    var a = i * golden;
    return [rad * Math.cos(a), y, rad * Math.sin(a)];
  }

  function makeProj(yaw, tilt, cx, cy, scale) {
    var st = Math.sin(tilt);
    var ct = Math.cos(tilt);
    var sy = Math.sin(yaw);
    var cyw = Math.cos(yaw);
    return function (x, y, z) {
      var x1 = x * cyw + z * sy;
      var z1 = -x * sy + z * cyw;
      var y1 = y * ct - z1 * st;
      var z2 = y * st + z1 * ct;
      return [cx + x1 * scale, cy - y1 * scale, z2];
    };
  }

  function frameWeb(size, t) {
    var o = OPTS;
    var cx = size / 2;
    var cy = size / 2;
    var R = (size / 2) * 0.8;
    var pt = makeProj(t * 0.12, 0.32, cx, cy, R);
    var rs = Math.pow(size / 300, o.rsPow);
    var nodeN = o.nodeN;
    var nodes = [];
    var i;
    var j;
    for (i = 0; i < nodeN; i++) {
      var d = fibDir(i, nodeN);
      var x = d[0] + 0.3 * (vnoise(i * 0.31 + 9, t * 0.24) - 0.5) * 2;
      var y = d[1] + 0.3 * (vnoise(i * 0.53 + 27, t * 0.21) - 0.5) * 2;
      var z = d[2] + 0.3 * (vnoise(i * 0.77 + 55, t * 0.27) - 0.5) * 2;
      var len = Math.sqrt(x * x + y * y + z * z);
      nodes.push([x / len, y / len, z / len]);
    }

    var lines = [];
    var dots = [];
    for (i = 0; i < nodeN; i++) {
      for (j = i + 1; j < nodeN; j++) {
        var dx = nodes[i][0] - nodes[j][0];
        var dy = nodes[i][1] - nodes[j][1];
        var dz = nodes[i][2] - nodes[j][2];
        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist >= o.thr) continue;
        var p1 = pt(nodes[i][0], nodes[i][1], nodes[i][2]);
        var p2 = pt(nodes[j][0], nodes[j][1], nodes[j][2]);
        var depth = ((p1[2] + p2[2]) / 2 + 1) / 2;
        var a = (1 - dist / o.thr) * (0.3 + 0.55 * depth);
        if (a < 0.02) continue;
        lines.push({
          x1: p1[0],
          y1: p1[1],
          x2: p2[0],
          y2: p2[1],
          white: 0.42,
          a: a,
          w: Math.max(0.6, o.lineW * rs),
        });
      }
    }

    for (i = 0; i < nodeN; i++) {
      var p = pt(nodes[i][0], nodes[i][1], nodes[i][2]);
      var nodeDepth = (p[2] + 1) / 2;
      var pulse = 1 + 0.25 * Math.sin(t * 1.4 + i * 2.7);
      dots.push({
        x: p[0],
        y: p[1],
        z: p[2],
        r: (o.nodeR + o.nodeRDepth * nodeDepth) * pulse * rs,
        white: 0.55 - 0.45 * nodeDepth,
      });
    }

    for (var s = 0; s < o.signals; s++) {
      var seg = Math.floor(t * 0.55 + s * 7.31);
      var ia = Math.floor(hashD(seg, s * 3.1 + 1.7) * nodeN);
      var ib = Math.floor(hashD(seg, s * 5.7 + 4.2) * nodeN);
      if (ia === ib) continue;
      var f = t * 0.55 + s * 7.31;
      f = f - Math.floor(f);
      var sx = nodes[ia][0] + (nodes[ib][0] - nodes[ia][0]) * f;
      var sy = nodes[ia][1] + (nodes[ib][1] - nodes[ia][1]) * f;
      var sz = nodes[ia][2] + (nodes[ib][2] - nodes[ia][2]) * f;
      var sl = Math.max(1e-6, Math.sqrt(sx * sx + sy * sy + sz * sz));
      var sp = pt(sx / sl, sy / sl, sz / sl);
      var sd = (sp[2] + 1) / 2;
      dots.push({
        x: sp[0],
        y: sp[1],
        z: sp[2],
        r: (o.nodeR * 1.5 + o.nodeRDepth * sd) * rs,
        white: 0.05,
        a: 0.5 + 0.5 * sd,
      });
    }

    var visible = [];
    for (i = 0; i < dots.length; i++) {
      var dot = dots[i];
      if ((dot.a == null ? 1 : dot.a) < 0.02) continue;
      dot.r = Math.max(o.rMin, dot.r);
      visible.push(dot);
    }
    visible.sort(function (a, b) {
      return a.z - b.z;
    });
    return { dots: visible, lines: lines };
  }

  function inkAlpha(white, alpha) {
    var w = Math.min(1, Math.max(0, white));
    var shown = dark ? 1 - w : w;
    var strength = dark ? shown : 1 - shown;
    return (alpha == null ? 1 : alpha) * (0.22 + 0.78 * strength);
  }

  function readTheme() {
    var root = document.documentElement;
    var resolved = root.dataset.resolvedTheme;
    dark = resolved
      ? resolved === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    var raw = getComputedStyle(root).getPropertyValue("--accent").trim();
    var m = /^#([0-9a-f]{6})$/i.exec(raw);
    if (!m) return;
    var n = parseInt(m[1], 16);
    accent = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function draw(size, t) {
    var frame = frameWeb(size, t);
    var rgb = accent[0] + "," + accent[1] + "," + accent[2];
    var i;
    ctx.clearRect(0, 0, size, size);
    ctx.lineCap = "round";
    for (i = 0; i < frame.lines.length; i++) {
      var line = frame.lines[i];
      ctx.strokeStyle = "rgba(" + rgb + "," + inkAlpha(line.white, line.a) + ")";
      ctx.lineWidth = line.w;
      ctx.beginPath();
      ctx.moveTo(line.x1, line.y1);
      ctx.lineTo(line.x2, line.y2);
      ctx.stroke();
    }
    for (i = 0; i < frame.dots.length; i++) {
      var dot = frame.dots[i];
      ctx.fillStyle = "rgba(" + rgb + "," + inkAlpha(dot.white, dot.a) + ")";
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function cssSize() {
    var rect = canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(2, Math.round(rect.width));
    var h = Math.max(2, Math.round(rect.height));
    var bw = Math.round(w * dpr);
    var bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return Math.min(w, h);
  }

  function showing() {
    return canvas.isConnected && !stage.hidden;
  }

  function tick(now) {
    raf = 0;
    if (!showing()) return;
    if (!started) started = now;
    readTheme();
    var size = cssSize();
    var t = reduced ? 0 : ((now - started) / 1000) * SPEED;
    draw(size, t);
    if (!reduced) raf = requestAnimationFrame(tick);
  }

  function start() {
    if (raf || !showing()) return;
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  new MutationObserver(function () {
    if (showing()) start();
    else stop();
  }).observe(stage, { attributes: true, attributeFilter: ["hidden"] });

  window.addEventListener("resize", function () {
    if (showing()) start();
  });

  var themeObs = new MutationObserver(readTheme);
  themeObs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-resolved-theme"],
  });

  readTheme();
  start();

  window.ylHideLoader = function () {
    if (!stage || stage.hidden) return;
    if (reduced || stage.classList.contains("is-leaving")) {
      if (reduced) {
        stage.classList.remove("is-leaving");
        stage.hidden = true;
      }
      return;
    }
    stage.classList.add("is-leaving");
    var done = false;
    function finish(event) {
      if (done) return;
      if (event && event.target !== stage) return;
      if (event && event.propertyName !== "opacity") return;
      done = true;
      if (!stage.classList.contains("is-leaving")) return;
      stage.hidden = true;
      stage.classList.remove("is-leaving");
    }
    stage.addEventListener("transitionend", finish);
    window.setTimeout(function () {
      finish();
    }, 700);
  };
})();
