// Commit activity chart — canvas-based sparkline.
// Adapted from flowstate commits widget (gruvbox palette, bezier interpolation).

const COLORS = {
  line: "#58a6ff",
  fill: "#58a6ff",
  grid: "#30363d",
  text: "#8b949e",
};

// Draw a commit activity chart into a canvas element.
// buckets: array of numbers (commit counts per day).
export function drawChart(canvas, buckets) {
  const ctx = canvas.getContext("2d");
  const dpr = devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;

  const w = canvas.width;
  const h = canvas.height;
  const pad = 2 * dpr;
  const n = buckets.length;

  ctx.clearRect(0, 0, w, h);
  if (n < 2) return;

  const max = Math.max(...buckets, 1);
  const stepX = (w - pad * 2) / (n - 1);
  const plotH = h - pad * 2;

  const points = buckets.map((v, i) => ({
    x: pad + i * stepX,
    y: pad + plotH - (v / max) * plotH,
  }));

  // Smooth bezier curve
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 0; i < n - 1; i++) {
    const cp = (points[i + 1].x - points[i].x) / 2;
    ctx.bezierCurveTo(
      points[i].x + cp, points[i].y,
      points[i + 1].x - cp, points[i + 1].y,
      points[i + 1].x, points[i + 1].y
    );
  }

  // Fill under curve
  const fillPath = new Path2D();
  fillPath.moveTo(points[0].x, points[0].y);
  for (let i = 0; i < n - 1; i++) {
    const cp = (points[i + 1].x - points[i].x) / 2;
    fillPath.bezierCurveTo(
      points[i].x + cp, points[i].y,
      points[i + 1].x - cp, points[i + 1].y,
      points[i + 1].x, points[i + 1].y
    );
  }
  fillPath.lineTo(points[n - 1].x, h);
  fillPath.lineTo(points[0].x, h);
  fillPath.closePath();

  ctx.save();

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, COLORS.fill + "30");
  grad.addColorStop(1, COLORS.fill + "05");
  ctx.fillStyle = grad;
  ctx.fill(fillPath);

  // Stroke
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 1.5 * dpr;
  ctx.lineJoin = "round";
  ctx.stroke();

  // Left-edge fade
  const fade = ctx.createLinearGradient(0, 0, w * 0.2, 0);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(1, "rgba(0,0,0,1)");
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, w * 0.2, h);
  // Rest stays fully opaque
  ctx.fillStyle = "rgba(0,0,0,1)";
  ctx.fillRect(w * 0.2, 0, w * 0.8, h);
  ctx.restore();
}
