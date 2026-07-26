import { describe, expect, it } from "vitest";

import {
  CENTERED_COVER,
  coverObjectPosition,
  coverSlack,
  dragCoverPos,
  formatCoverPos,
  nudgeCoverPos,
  parseCoverPos,
} from "./coverPosition";

describe("parseCoverPos", () => {
  it("reads the stored format", () => {
    expect(parseCoverPos("20,80")).toEqual({ x: 20, y: 80 });
    expect(parseCoverPos("50,32.5")).toEqual({ x: 50, y: 32.5 });
  });

  it("falls back to centered on anything unusable", () => {
    expect(parseCoverPos(null)).toEqual(CENTERED_COVER);
    expect(parseCoverPos("")).toEqual(CENTERED_COVER);
    expect(parseCoverPos("garbage")).toEqual(CENTERED_COVER);
    expect(parseCoverPos("40")).toEqual(CENTERED_COVER);
  });

  it("clamps out-of-range stored values", () => {
    expect(parseCoverPos("-30,300")).toEqual({ x: 0, y: 100 });
  });
});

describe("formatCoverPos", () => {
  it("rounds to one decimal and clamps", () => {
    expect(formatCoverPos({ x: 33.333, y: 66.666 })).toBe("33.3,66.7");
    expect(formatCoverPos({ x: -5, y: 140 })).toBe("0,100");
  });

  it("round-trips through parse", () => {
    expect(parseCoverPos(formatCoverPos({ x: 12.3, y: 87.6 }))).toEqual({ x: 12.3, y: 87.6 });
  });
});

describe("coverSlack", () => {
  it("gives the overflow of the axis that overflows", () => {
    // 1000x1000 image in a 1000x200 box → scale 1 (width fits), 800px of vertical slack.
    expect(coverSlack({ w: 1000, h: 1000 }, { w: 1000, h: 200 })).toEqual({ w: 0, h: 800 });
    // 400x200 image in a 200x200 box → scale 1 on height, 200px of horizontal slack.
    expect(coverSlack({ w: 400, h: 200 }, { w: 200, h: 200 })).toEqual({ w: 200, h: 0 });
  });

  it("has no slack when the ratios match", () => {
    expect(coverSlack({ w: 800, h: 400 }, { w: 400, h: 200 })).toEqual({ w: 0, h: 0 });
  });

  it("tolerates degenerate sizes (image not loaded yet)", () => {
    expect(coverSlack({ w: 0, h: 0 }, { w: 100, h: 100 })).toEqual({ w: 0, h: 0 });
    expect(coverSlack({ w: 100, h: 100 }, { w: 0, h: 0 })).toEqual({ w: 0, h: 0 });
  });
});

describe("dragCoverPos", () => {
  const slack = { w: 0, h: 800 };

  it("dragging the image down reveals its top (focal point decreases)", () => {
    expect(dragCoverPos({ x: 50, y: 50 }, 0, 80, slack)).toEqual({ x: 50, y: 40 });
  });

  it("dragging up increases the focal point", () => {
    expect(dragCoverPos({ x: 50, y: 50 }, 0, -80, slack)).toEqual({ x: 50, y: 60 });
  });

  it("never goes past the edges — no gap possible", () => {
    expect(dragCoverPos({ x: 50, y: 50 }, 0, 5000, slack)).toEqual({ x: 50, y: 0 });
    expect(dragCoverPos({ x: 50, y: 50 }, 0, -5000, slack)).toEqual({ x: 50, y: 100 });
  });

  it("leaves an axis without slack untouched", () => {
    expect(dragCoverPos({ x: 50, y: 50 }, 300, 0, slack)).toEqual({ x: 50, y: 50 });
    expect(dragCoverPos({ x: 50, y: 50 }, 0, 100, { w: 200, h: 0 })).toEqual({ x: 50, y: 50 });
  });

  it("pans horizontally when the width overflows", () => {
    expect(dragCoverPos({ x: 50, y: 50 }, 100, 0, { w: 200, h: 0 })).toEqual({ x: 0, y: 50 });
  });
});

describe("nudgeCoverPos", () => {
  it("moves by percentage points, clamped", () => {
    expect(nudgeCoverPos({ x: 50, y: 50 }, 0, -2)).toEqual({ x: 50, y: 48 });
    expect(nudgeCoverPos({ x: 1, y: 99 }, -2, 2)).toEqual({ x: 0, y: 100 });
  });
});

describe("coverObjectPosition", () => {
  it("renders the CSS value", () => {
    expect(coverObjectPosition({ x: 50, y: 32.5 })).toBe("50% 32.5%");
    expect(coverObjectPosition({ x: -10, y: 200 })).toBe("0% 100%");
  });
});
