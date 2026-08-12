import { describe, expect, it } from "vitest";
import {
  createStrokeProgressCells,
  createStrokeGuideSamples,
  projectPointerToStrokeGuide,
  strokeGuidePath,
  strokeProgressCellPath,
  type StrokeGuidePoint,
} from "./strokeGuide";

const TEST_BOUNDS = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

function pointInPolygon(point: StrokeGuidePoint, polygon: StrokeGuidePoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const crosses = (currentPoint.y > point.y) !== (previousPoint.y > point.y);
    if (!crosses) continue;
    const intersectionX = previousPoint.x
      + (point.y - previousPoint.y)
      * (currentPoint.x - previousPoint.x)
      / (currentPoint.y - previousPoint.y);
    if (point.x < intersectionX) inside = !inside;
  }
  return inside;
}

describe("stroke direction guide geometry", () => {
  it("builds a dense smooth path that keeps the original endpoints", () => {
    const samples = createStrokeGuideSamples([
      { x: 10, y: 30 },
      { x: 70, y: 10 },
      { x: 120, y: 80 },
      { x: 190, y: 40 },
    ]);

    expect(samples.length).toBeGreaterThan(20);
    expect(samples[0]).toEqual({ x: 10, y: 30 });
    expect(samples[samples.length - 1]).toEqual({ x: 190, y: 40 });
    expect(strokeGuidePath(samples)).toMatch(/^M 10 30 L /);
    expect(strokeGuidePath(samples)).not.toMatch(/NaN|Infinity/);
  });

  it("projects forward without moving backwards or jumping across a crossing", () => {
    const samples = Array.from({ length: 60 }, (_, index) => ({
      x: index < 30 ? index * 4 : (59 - index) * 4,
      y: index < 30 ? index * 3 : (index - 30) * 3,
    }));

    const first = projectPointerToStrokeGuide(samples, samples[8], 0);
    expect(first?.index).toBe(8);

    const behind = projectPointerToStrokeGuide(samples, samples[2], 8);
    expect(behind?.index).toBe(8);

    const crossing = projectPointerToStrokeGuide(samples, samples[50], 8);
    expect(crossing?.index).toBeLessThanOrEqual(18);
  });

  it("holds the handle at its last valid point when the pointer leaves the guide", () => {
    const samples = createStrokeGuideSamples([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    const position = projectPointerToStrokeGuide(samples, { x: 80, y: 100 }, 4);
    expect(position?.index).toBe(4);
  });

  it("partitions straight and curved guides into finite ordered progress cells", () => {
    const straight = createStrokeProgressCells([
      { x: 20, y: 50 },
      { x: 50, y: 50 },
      { x: 80, y: 50 },
    ], TEST_BOUNDS);
    expect(straight.map(({ sampleIndex }) => sampleIndex)).toEqual([0, 1, 2]);
    expect(pointInPolygon({ x: 10, y: 50 }, straight[0].points)).toBe(true);
    expect(pointInPolygon({ x: 50, y: 50 }, straight[1].points)).toBe(true);
    expect(pointInPolygon({ x: 90, y: 50 }, straight[2].points)).toBe(true);

    const curvedSamples = createStrokeGuideSamples([
      { x: 10, y: 70 },
      { x: 45, y: 20 },
      { x: 90, y: 70 },
    ]);
    const curved = createStrokeProgressCells(curvedSamples, TEST_BOUNDS);
    expect(curved).toHaveLength(curvedSamples.length);
    expect(curved.every(({ points }) => (
      points.length >= 3
      && points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))
      && !strokeProgressCellPath(points).match(/NaN|Infinity/)
    ))).toBe(true);
  });

  it("keeps a nearby future branch outside completed cells", () => {
    const samples = [
      { x: 15, y: 20 },
      { x: 42, y: 45 },
      { x: 80, y: 80 },
      { x: 82, y: 20 },
      { x: 56, y: 45 },
      { x: 18, y: 80 },
    ];
    const cells = createStrokeProgressCells(samples, TEST_BOUNDS);
    const futurePoint = samples[4];
    const completedCells = cells.filter(({ sampleIndex }) => sampleIndex <= 1);
    expect(completedCells.some(({ points }) => pointInPolygon(futurePoint, points))).toBe(false);
    expect(pointInPolygon(futurePoint, cells.find(({ sampleIndex }) => sampleIndex === 4)!.points))
      .toBe(true);
  });

  it("gives an exact self-intersection to the later visit", () => {
    const crossing = { x: 50, y: 50 };
    const cells = createStrokeProgressCells([
      { x: 10, y: 10 },
      crossing,
      { x: 90, y: 90 },
      { x: 90, y: 10 },
      crossing,
      { x: 10, y: 90 },
    ], TEST_BOUNDS);
    expect(cells.some(({ sampleIndex }) => sampleIndex === 1)).toBe(false);
    const laterCell = cells.find(({ sampleIndex }) => sampleIndex === 4);
    expect(laterCell).toBeDefined();
    expect(pointInPolygon(crossing, laterCell!.points)).toBe(true);
  });

  it("returns no progress cells for invalid geometry", () => {
    expect(createStrokeProgressCells([], TEST_BOUNDS)).toEqual([]);
    expect(createStrokeProgressCells([{ x: Number.NaN, y: 0 }], TEST_BOUNDS)).toEqual([]);
    expect(createStrokeProgressCells([{ x: 0, y: 0 }], {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 100,
    })).toEqual([]);
  });
});
