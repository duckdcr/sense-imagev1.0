import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseCsvRows } from "../src/csvRows.js";
import { createFabricCatalog } from "../src/fabricCatalog.js";

test("parses quoted CSV fields, escaped quotes, embedded newlines and CRLF", () => {
  const rows = parseCsvRows(
    '\uFEFFsku,composition,note\r\nA-01,"65% Polyester, 35% Linen","line 1\nline ""2"""\r\n',
  );

  assert.deepEqual(rows, [
    {
      sku: "A-01",
      composition: "65% Polyester, 35% Linen",
      note: 'line 1\nline "2"',
    },
  ]);
});

async function makeCatalogFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "fabric-catalog-"));
  const csvPath = path.join(root, "catalog.csv");
  const repeatImageDir = path.join(root, "repeat");
  await mkdir(repeatImageDir);
  await writeFile(
    csvPath,
    [
      "工厂sku*,花位纵向长(cm),花位横向长(cm),成分*",
      'PLAIN-01,/,/,"65% Polyester, 35% Linen"',
      "REPEAT-01,71,73,98%Polyester 2%Lurex",
      "BROKEN-01,/,20,100%Polyester",
      "INVALID-01,0,20,100%Polyester",
      "MISSING-IMAGE,30,40,100%Polyester",
      "DUP-01,30,40,100%Polyester",
    ].join("\r\n"),
    "utf8",
  );
  await writeFile(path.join(repeatImageDir, "REPEAT-01_detail.jpg"), "repeat");
  await writeFile(path.join(repeatImageDir, "DUP-01_detail.jpg"), "repeat-a");
  await writeFile(path.join(repeatImageDir, "DUP-01_detail.png"), "repeat-b");
  return { csvPath, repeatImageDir };
}

test("resolves plain and repeat catalog entries with filename sample size priority", async () => {
  const fixture = await makeCatalogFixture();
  const catalog = createFabricCatalog(fixture);

  const plain = await catalog.resolve({
    fileName: "PLAIN-01_detail_15.jpg",
    fallbackSampleSizeCm: 10,
  });
  assert.deepEqual(
    {
      sku: plain.sku,
      sampleSizeCm: plain.sampleSizeCm,
      sampleSizeSource: plain.sampleSizeSource,
      fabricMode: plain.fabricMode,
      composition: plain.composition,
      repeatVerticalCm: plain.repeatVerticalCm,
      repeatHorizontalCm: plain.repeatHorizontalCm,
      repeatImagePath: plain.repeatImagePath,
    },
    {
      sku: "PLAIN-01",
      sampleSizeCm: 15,
      sampleSizeSource: "filename",
      fabricMode: "plain",
      composition: "65% Polyester, 35% Linen",
      repeatVerticalCm: null,
      repeatHorizontalCm: null,
      repeatImagePath: null,
    },
  );

  const repeat = await catalog.resolve({
    fileName: "REPEAT-01_detail.jpg",
    fallbackSampleSizeCm: 10,
  });
  assert.equal(repeat.sampleSizeCm, 10);
  assert.equal(repeat.sampleSizeSource, "fallback");
  assert.equal(repeat.fabricMode, "repeat");
  assert.equal(repeat.repeatVerticalCm, 71);
  assert.equal(repeat.repeatHorizontalCm, 73);
  assert.equal(repeat.repeatImageName, "REPEAT-01_detail.jpg");
  assert.equal(repeat.repeatImagePath, path.join(fixture.repeatImageDir, "REPEAT-01_detail.jpg"));
});

test("rejects incomplete catalog data and ambiguous repeat images", async () => {
  const fixture = await makeCatalogFixture();
  const catalog = createFabricCatalog(fixture);

  await assert.rejects(
    catalog.resolve({ fileName: "UNKNOWN_detail_10.jpg", fallbackSampleSizeCm: 10 }),
    /CSV.*UNKNOWN/,
  );
  await assert.rejects(
    catalog.resolve({ fileName: "BROKEN-01_detail_10.jpg", fallbackSampleSizeCm: 10 }),
    /花位纵向长.*花位横向长.*必须同时/,
  );
  await assert.rejects(
    catalog.resolve({ fileName: "INVALID-01_detail_10.jpg", fallbackSampleSizeCm: 10 }),
    /大于 0/,
  );
  await assert.rejects(
    catalog.resolve({ fileName: "MISSING-IMAGE_detail_10.jpg", fallbackSampleSizeCm: 10 }),
    /MISSING-IMAGE.*完整花位图/,
  );
  await assert.rejects(
    catalog.resolve({ fileName: "DUP-01_detail_10.jpg", fallbackSampleSizeCm: 10 }),
    /多个完整花位图.*DUP-01/,
  );
});
