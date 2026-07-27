export interface StrokeGuidePoint {
  x: number;
  y: number;
}

export interface StrokeGuidePosition extends StrokeGuidePoint {
  angle: number;
  index: number;
}

export interface StrokeProgressBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface StrokeProgressCell {
  sampleIndex: number;
  points: StrokeGuidePoint[];
}

const MIN_SAMPLE_SPACING = 5;
const MAX_SEGMENT_SAMPLES = 32;
const MAX_POINTER_DISTANCE = 44;
const GEOMETRY_EPSILON = 1e-6;

function distance(left: StrokeGuidePoint, right: StrokeGuidePoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function mix(
  left: StrokeGuidePoint,
  right: StrokeGuidePoint,
  leftWeight: number,
  rightWeight: number,
): StrokeGuidePoint {
  return {
    x: left.x * leftWeight + right.x * rightWeight,
    y: left.y * leftWeight + right.y * rightWeight,
  };
}

function extrapolate(from: StrokeGuidePoint, toward: StrokeGuidePoint): StrokeGuidePoint {
  return {
    x: from.x * 2 - toward.x,
    y: from.y * 2 - toward.y,
  };
}

function knot(previous: number, left: StrokeGuidePoint, right: StrokeGuidePoint): number {
  return previous + Math.sqrt(Math.max(distance(left, right), Number.EPSILON));
}

function centripetalPoint(
  point0: StrokeGuidePoint,
  point1: StrokeGuidePoint,
  point2: StrokeGuidePoint,
  point3: StrokeGuidePoint,
  progress: number,
): StrokeGuidePoint {
  const time0 = 0;
  const time1 = knot(time0, point0, point1);
  const time2 = knot(time1, point1, point2);
  const time3 = knot(time2, point2, point3);
  const time = time1 + (time2 - time1) * progress;
  const pointA1 = mix(
    point0,
    point1,
    (time1 - time) / (time1 - time0),
    (time - time0) / (time1 - time0),
  );
  const pointA2 = mix(
    point1,
    point2,
    (time2 - time) / (time2 - time1),
    (time - time1) / (time2 - time1),
  );
  const pointA3 = mix(
    point2,
    point3,
    (time3 - time) / (time3 - time2),
    (time - time2) / (time3 - time2),
  );
  const pointB1 = mix(
    pointA1,
    pointA2,
    (time2 - time) / (time2 - time0),
    (time - time0) / (time2 - time0),
  );
  const pointB2 = mix(
    pointA2,
    pointA3,
    (time3 - time) / (time3 - time1),
    (time - time1) / (time3 - time1),
  );
  return mix(
    pointB1,
    pointB2,
    (time2 - time) / (time2 - time1),
    (time - time1) / (time2 - time1),
  );
}

function uniquePoints(points: StrokeGuidePoint[]): StrokeGuidePoint[] {
  return points.filter((point, index) => (
    index === 0 || distance(point, points[index - 1]) > .01
  ));
}

export function createStrokeGuideSamples(points: StrokeGuidePoint[]): StrokeGuidePoint[] {
  const source = uniquePoints(points);
  if (source.length < 2) return source;
  const samples: StrokeGuidePoint[] = [];

  source.slice(0, -1).forEach((point1, index) => {
    const point2 = source[index + 1];
    const point0 = source[index - 1] ?? extrapolate(point1, point2);
    const point3 = source[index + 2] ?? extrapolate(point2, point1);
    const sampleCount = Math.min(
      MAX_SEGMENT_SAMPLES,
      Math.max(2, Math.ceil(distance(point1, point2) / MIN_SAMPLE_SPACING)),
    );
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      samples.push(centripetalPoint(
        point0,
        point1,
        point2,
        point3,
        sampleIndex / sampleCount,
      ));
    }
  });
  samples.push(source[source.length - 1]);
  return samples;
}

function rounded(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function clipPolygonToCloserHalfPlane(
  polygon: StrokeGuidePoint[],
  site: StrokeGuidePoint,
  competitor: StrokeGuidePoint,
): StrokeGuidePoint[] {
  if (!polygon.length) return polygon;
  const normalX = competitor.x - site.x;
  const normalY = competitor.y - site.y;
  const offset = (
    competitor.x * competitor.x
    + competitor.y * competitor.y
    - site.x * site.x
    - site.y * site.y
  ) / 2;
  const signedDistance = (point: StrokeGuidePoint) => (
    normalX * point.x + normalY * point.y - offset
  );
  const clipped: StrokeGuidePoint[] = [];

  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const startDistance = signedDistance(start);
    const endDistance = signedDistance(end);
    const startInside = startDistance <= GEOMETRY_EPSILON;
    const endInside = endDistance <= GEOMETRY_EPSILON;

    if (startInside) clipped.push(start);
    if (startInside === endInside) continue;
    const denominator = startDistance - endDistance;
    if (Math.abs(denominator) <= GEOMETRY_EPSILON) continue;
    const progress = startDistance / denominator;
    clipped.push({
      x: start.x + (end.x - start.x) * progress,
      y: start.y + (end.y - start.y) * progress,
    });
  }
  return clipped;
}

function validBounds(bounds: StrokeProgressBounds): boolean {
  return Number.isFinite(bounds.minX)
    && Number.isFinite(bounds.minY)
    && Number.isFinite(bounds.maxX)
    && Number.isFinite(bounds.maxY)
    && bounds.maxX > bounds.minX
    && bounds.maxY > bounds.minY;
}

export function createStrokeProgressCells(
  samples: StrokeGuidePoint[],
  bounds: StrokeProgressBounds,
): StrokeProgressCell[] {
  if (
    !samples.length
    || !validBounds(bounds)
    || samples.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))
  ) {
    return [];
  }
  const boundary = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];
  const cells: StrokeProgressCell[] = [];

  samples.forEach((site, sampleIndex) => {
    let points = boundary.map((point) => ({ ...point }));
    for (let competitorIndex = 0; competitorIndex < samples.length; competitorIndex += 1) {
      if (competitorIndex === sampleIndex) continue;
      const competitor = samples[competitorIndex];
      if (distance(site, competitor) <= GEOMETRY_EPSILON) {
        // Defer an exact self-intersection to the later visit along the guide.
        if (competitorIndex > sampleIndex) points = [];
        continue;
      }
      points = clipPolygonToCloserHalfPlane(points, site, competitor);
      if (points.length < 3) break;
    }
    if (points.length >= 3) cells.push({ sampleIndex, points });
  });
  return cells;
}

export function strokeProgressCellPath(points: StrokeGuidePoint[]): string {
  if (points.length < 3) return "";
  return `${points.map((point, index) => (
    `${index ? "L" : "M"} ${rounded(point.x)} ${rounded(point.y)}`
  )).join(" ")} Z`;
}

export function strokeGuidePath(samples: StrokeGuidePoint[]): string {
  if (!samples.length) return "";
  return samples
    .map((point, index) => `${index ? "L" : "M"} ${rounded(point.x)} ${rounded(point.y)}`)
    .join(" ");
}

export function strokeGuidePosition(
  samples: StrokeGuidePoint[],
  index: number,
): StrokeGuidePosition | null {
  if (!samples.length) return null;
  const boundedIndex = Math.max(0, Math.min(samples.length - 1, index));
  const point = samples[boundedIndex];
  const before = samples[Math.max(0, boundedIndex - 1)];
  const after = samples[Math.min(samples.length - 1, boundedIndex + 1)];
  return {
    ...point,
    angle: Math.atan2(after.y - before.y, after.x - before.x) * 180 / Math.PI,
    index: boundedIndex,
  };
}

export function projectPointerToStrokeGuide(
  samples: StrokeGuidePoint[],
  pointer: StrokeGuidePoint,
  previousIndex: number,
): StrokeGuidePosition | null {
  if (!samples.length) return null;
  const boundedPrevious = Math.max(0, Math.min(samples.length - 1, previousIndex));
  const lookAhead = Math.max(10, Math.ceil(samples.length * .16));
  const endIndex = Math.min(samples.length - 1, boundedPrevious + lookAhead);
  let nearestIndex = boundedPrevious;
  let nearestDistance = distance(pointer, samples[boundedPrevious]);

  for (let index = boundedPrevious + 1; index <= endIndex; index += 1) {
    const nextDistance = distance(pointer, samples[index]);
    if (nextDistance < nearestDistance) {
      nearestDistance = nextDistance;
      nearestIndex = index;
    }
  }
  if (nearestDistance > MAX_POINTER_DISTANCE) {
    return strokeGuidePosition(samples, boundedPrevious);
  }
  return strokeGuidePosition(samples, nearestIndex);
}
